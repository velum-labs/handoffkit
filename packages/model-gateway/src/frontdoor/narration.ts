/**
 * Live turn narration ("reasoning traces to the front doors").
 *
 * While a streaming fused turn runs, this module turns the in-process trace
 * events the harnesses already emit into a narrated race, exposed as
 * `reasoning.delta` events that interleave with the turn's runtime stream. The
 * SSE adapter serializes them as OpenAI chat chunks carrying
 * `delta.reasoning_content`, which each dialect translator renders on its
 * native reasoning channel (Codex reasoning summaries, Claude thinking).
 *
 * The narration is designed for how the channel actually renders:
 *
 *  - Codex's TUI promotes the latest `**bold**` segment to its live "Working"
 *    status header, so every bold line is a complete, present-tense state.
 *  - The full block persists as a markdown transcript, so beats follow OpenAI's
 *    native reasoning-summary shape: bold headline + one short prose sentence.
 *
 * Beat rules: beats fire on state change only (candidate starts are silent —
 * the fan-out headline covers them), quiet periods get escalating "still
 * working" beats that never repeat verbatim, and model-generated text is
 * sanitized and attributed before it enters the channel. Narration is strictly
 * best-effort: it never delays or reorders judge tokens (the merge stops
 * draining narration at the first `sse.chunk`) and a narrator failure can never
 * fail a turn.
 */

import { addTraceListener, removeTraceListener } from "@fusionkit/protocol";
import type { FusionTraceEvent } from "@fusionkit/protocol";
import type { RuntimeEvent } from "@fusionkit/kernel";

/** A narration delta for the client stream (serialized as `delta.reasoning_content`). */
export type ReasoningDeltaEvent = { type: "reasoning.delta"; text: string };

/** The live narration channel for one streaming fused turn. */
export type TurnNarration = {
  events: AsyncIterable<ReasoningDeltaEvent>;
  /** Stop listening and end the event iterable (idempotent). */
  close: () => void;
};

type ReasoningQueue = {
  push: (text: string) => void;
  end: () => void;
  iterable: AsyncIterable<ReasoningDeltaEvent>;
};

/** A single-consumer async queue of narration deltas. */
function createReasoningQueue(): ReasoningQueue {
  const buffered: string[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  const wake = (): void => {
    const resolve = notify;
    notify = undefined;
    resolve?.();
  };
  return {
    push(text) {
      if (ended) return;
      buffered.push(text);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          for (;;) {
            const next = buffered.shift();
            if (next === undefined) break;
            yield { type: "reasoning.delta", text: next } as const;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      }
    }
  };
}

// ---- formatting helpers (exported for tests) ------------------------------

/** Compact human elapsed time ("42s", "2m05s"). */
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * One safe prose line from model-generated text: first non-empty line, markdown
 * and control characters stripped, whitespace collapsed, hard length cap. The
 * result is always quoted behind attribution ("proposes: ..."), never emitted
 * as a headline, so round-tripped reasoning cannot read as instruction.
 */
export function sanitizeGist(text: string, maxLength = 90): string | undefined {
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

export type DiffStat = { files: number; added: number; removed: number };

/** Unified-diff stats: changed file count and +/- line counts. */
export function diffStat(diff: string | undefined): DiffStat | undefined {
  if (diff === undefined || diff.length === 0) return undefined;
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("Index: ")) files += 1;
    else if (line.startsWith("+++")) {
      if (files === 0) files = 1; // headerless single-file diff
    } else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("---")) continue;
    else if (line.startsWith("-")) removed += 1;
  }
  if (files === 0 && added === 0 && removed === 0) return undefined;
  return { files: Math.max(files, 1), added, removed };
}

/** The set of changed file paths in a unified diff (for convergence checks). */
export function changedFiles(diff: string | undefined): string[] {
  if (diff === undefined) return [];
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const path = line.slice(4).trim().replace(/^b\//, "");
    if (path.length > 0 && path !== "/dev/null") paths.add(path);
  }
  return [...paths].sort();
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---- the beat engine (pure state machine, exported for tests) --------------

export type NarratorBeat = { headline: string; prose?: string };

export type CandidateFinish = {
  id: string;
  ok: boolean;
  finishReason?: string;
  elapsedMs?: number;
  steps?: number;
  gist?: string;
};

/** One judge-time candidate fact sheet (mined from the judge.request payload). */
export type JudgeCandidate = {
  id: string;
  ok: boolean;
  diff?: string;
  verificationStatus?: string;
};

export type NarrationTrigger =
  | { kind: "fanout"; roster: Array<{ id: string; model?: string }>; at: number }
  | { kind: "finish"; finish: CandidateFinish; at: number }
  | { kind: "judging"; candidates: JudgeCandidate[]; at: number }
  | { kind: "quiet"; at: number };

export type NarratorState = {
  turn: number;
  judgeModel?: string;
  /** The model the judge picked last turn (opener color). */
  lastPick?: string;
  roster: Array<{ id: string; model?: string }>;
  finishes: CandidateFinish[];
  phase: "panel" | "judging";
  /** True once any panel activity was seen this turn (fan-out or candidates). */
  sawPanel: boolean;
  startedAt?: number;
  lastBeatAt?: number;
  quietStage: number;
};

export function createNarratorState(input: {
  turn: number;
  judgeModel?: string;
  lastPick?: string;
}): NarratorState {
  return {
    turn: input.turn,
    ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
    ...(input.lastPick !== undefined ? { lastPick: input.lastPick } : {}),
    roster: [],
    finishes: [],
    phase: "panel",
    sawPanel: false,
    quietStage: 0
  };
}

function outstandingIds(state: NarratorState): string[] {
  const done = new Set(state.finishes.map((finish) => finish.id));
  return state.roster.map((member) => member.id).filter((id) => !done.has(id));
}

function finishFacts(finish: CandidateFinish): string {
  const bits: string[] = [];
  if (finish.steps !== undefined && finish.steps > 0) bits.push(plural(finish.steps, "step"));
  if (finish.elapsedMs !== undefined) bits.push(elapsedLabel(finish.elapsedMs));
  return bits.length > 0 ? ` (${bits.join(", ")})` : "";
}

function renderFanout(state: NarratorState): NarratorBeat {
  const count = state.roster.length;
  const headline =
    state.lastPick !== undefined
      ? `Last turn the judge picked ${state.lastPick} — fanning out again`
      : count > 0
        ? `Fanning out to ${plural(count, "model")}`
        : "Fanning out to the panel";
  const names = state.roster.map((member) => member.model ?? member.id);
  const prose =
    names.length > 1
      ? `${joinNames(names)} are each taking a shot in isolated worktrees.`
      : names.length === 1
        ? `${names[0]} is taking a shot in an isolated worktree.`
        : undefined;
  return { headline, ...(prose !== undefined ? { prose } : {}) };
}

function renderFinish(state: NarratorState, finish: CandidateFinish): NarratorBeat {
  const ordinal = state.finishes.length;
  const total = state.roster.length;
  const waiting = outstandingIds(state);
  const okCount = state.finishes.filter((entry) => entry.ok).length;

  if (!finish.ok) {
    const verb = finish.finishReason === "timeout" ? "timed out" : `failed (${finish.finishReason ?? "error"})`;
    const headline =
      waiting.length > 0
        ? `${finish.id} ${verb} — ${joinNames(waiting)} still working`
        : okCount > 0
          ? `${finish.id} ${verb} — judging the ${okCount === 1 ? "1 survivor" : `${okCount} survivors`}`
          : `${finish.id} ${verb}`;
    return { headline };
  }

  const gistProse = (subject: string | undefined): string | undefined =>
    finish.gist !== undefined
      ? `${subject !== undefined ? `${subject} proposes` : "Proposes"}: ${finish.gist}${finishFacts(finish)}`
      : undefined;

  if (ordinal === 1) {
    const timing = finish.elapsedMs !== undefined ? ` — ${elapsedLabel(finish.elapsedMs)}` : "";
    const prose = gistProse(undefined);
    return { headline: `${finish.id} is back first${timing}`, ...(prose !== undefined ? { prose } : {}) };
  }
  if (total > 0 && ordinal >= total) {
    const prose = gistProse(finish.id);
    return { headline: `All ${total} candidates in`, ...(prose !== undefined ? { prose } : {}) };
  }
  const headline =
    total > 0
      ? `${ordinal} of ${total} done — waiting on ${joinNames(waiting)}`
      : `${finish.id} finished${finish.elapsedMs !== undefined ? ` — ${elapsedLabel(finish.elapsedMs)}` : ""}`;
  const prose = gistProse(finish.id);
  return { headline, ...(prose !== undefined ? { prose } : {}) };
}

function verificationLabel(status: string | undefined): string | undefined {
  if (status === "passed") return "tests pass";
  if (status === "failed") return "tests fail";
  return undefined;
}

function renderJudging(state: NarratorState, candidates: JudgeCandidate[]): NarratorBeat {
  const withJudge = state.judgeModel !== undefined ? ` with ${state.judgeModel}` : "";
  if (!state.sawPanel) {
    return { headline: `Continuing turn ${state.turn} — candidates cached, judging${withJudge}` };
  }
  const usable = candidates.filter((candidate) => candidate.ok);
  const hadFailures = state.finishes.some((finish) => !finish.ok) || usable.length < candidates.length;
  const what = hadFailures
    ? `the ${usable.length === 1 ? "1 survivor" : `${usable.length} survivors`}`
    : plural(usable.length, "candidate");
  const headline = `Judging ${what}${withJudge}`;

  const sentences: string[] = [];
  for (const candidate of usable.slice(0, 3)) {
    const stat = diffStat(candidate.diff);
    const verify = verificationLabel(candidate.verificationStatus);
    const bits = [
      ...(stat !== undefined ? [`+${stat.added}/-${stat.removed} across ${plural(stat.files, "file")}`] : []),
      ...(verify !== undefined ? [verify] : [])
    ];
    if (bits.length > 0) sentences.push(`${candidate.id}'s patch: ${bits.join(", ")}.`);
  }
  // Convergence: candidates whose patches touch the same file set.
  const withFiles = usable
    .map((candidate) => ({ id: candidate.id, files: changedFiles(candidate.diff).join("\u0000") }))
    .filter((entry) => entry.files.length > 0);
  const byFiles = new Map<string, string[]>();
  for (const entry of withFiles) {
    byFiles.set(entry.files, [...(byFiles.get(entry.files) ?? []), entry.id]);
  }
  const converging = [...byFiles.values()].find((ids) => ids.length >= 2);
  if (converging !== undefined) sentences.push(`${joinNames(converging)} touch the same files.`);

  return { headline, ...(sentences.length > 0 ? { prose: sentences.join(" ") } : {}) };
}

function renderQuiet(state: NarratorState, at: number): NarratorBeat | null {
  const elapsed = state.startedAt !== undefined ? ` (${elapsedLabel(at - state.startedAt)})` : "";
  if (state.phase === "judging") {
    const judge = state.judgeModel !== undefined ? ` — ${state.judgeModel} at work` : "";
    return { headline: `Still judging${judge}${elapsed}` };
  }
  if (!state.sawPanel) return null;
  const waiting = outstandingIds(state);
  if (state.roster.length > 0 && waiting.length === 0) return null;
  const who = waiting.length > 0 ? ` — waiting on ${joinNames(waiting)}` : "";
  return { headline: `Still working${who}${elapsed}` };
}

/**
 * Apply a trigger to the narrator state and render the beat it warrants (or
 * null for silence). Pure apart from mutating `state` — deterministic and
 * directly unit-testable.
 */
export function narrationBeat(state: NarratorState, trigger: NarrationTrigger): NarratorBeat | null {
  state.startedAt ??= trigger.at;
  switch (trigger.kind) {
    case "fanout": {
      if (state.sawPanel) return null;
      state.sawPanel = true;
      state.roster = trigger.roster;
      return renderFanout(state);
    }
    case "finish": {
      state.sawPanel = true;
      if (state.finishes.some((finish) => finish.id === trigger.finish.id)) return null;
      state.finishes.push(trigger.finish);
      return renderFinish(state, trigger.finish);
    }
    case "judging": {
      const beat = renderJudging(state, trigger.candidates);
      state.phase = "judging";
      return beat;
    }
    case "quiet":
      return renderQuiet(state, trigger.at);
    default: {
      const exhaustive: never = trigger;
      throw new Error(`unknown narration trigger: ${String(exhaustive)}`);
    }
  }
}

// ---- the live narrator ------------------------------------------------------

export type TurnNarratorInput = {
  /** The session trace id: only this session's events are narrated. */
  traceId: string;
  /** The 1-based user-turn index: other turns' events are ignored. */
  turn: number;
  /** The configured judge model name, for the judging headline. */
  judgeModel?: string;
  /** The model the judge picked last turn (opener color). */
  lastPick?: string;
  /** Quiet-beat escalation delays; injectable for tests. */
  quietDelaysMs?: readonly number[];
};

const DEFAULT_QUIET_DELAYS_MS: readonly number[] = [25_000, 60_000, 120_000];
const QUIET_POLL_MS = 5_000;

function candidateLabel(event: FusionTraceEvent): string | undefined {
  return event.model_id ?? event.candidate_id;
}

function rosterOf(payload: Record<string, unknown>): Array<{ id: string; model?: string }> {
  const environment = payload.environment as
    | { models?: Array<{ id?: unknown; model?: unknown }> }
    | undefined;
  const models = Array.isArray(environment?.models) ? environment.models : [];
  return models
    .filter((entry): entry is { id: string; model?: unknown } => typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      ...(typeof entry.model === "string" ? { model: entry.model } : {})
    }));
}

function judgeCandidatesOf(payload: Record<string, unknown>): JudgeCandidate[] {
  const wires = Array.isArray(payload.trajectories) ? payload.trajectories : [];
  return wires
    .filter((wire): wire is Record<string, unknown> => wire !== null && typeof wire === "object")
    .map((wire) => {
      const id =
        typeof wire.model_id === "string" && wire.model_id.length > 0
          ? wire.model_id
          : typeof wire.trajectory_id === "string"
            ? wire.trajectory_id
            : "candidate";
      const verification = wire.verification as { status?: unknown } | undefined;
      return {
        id,
        ok: wire.status !== "failed",
        ...(typeof wire.diff === "string" ? { diff: wire.diff } : {}),
        ...(typeof verification?.status === "string" ? { verificationStatus: verification.status } : {})
      };
    });
}

/**
 * Subscribe to the in-process trace stream and narrate one turn as beats. Each
 * beat renders as a bold markdown headline (Codex's live status header — its
 * TUI hides reasoning without bold markers) plus an optional prose sentence.
 */
export function createTurnNarrator(input: TurnNarratorInput): TurnNarration {
  const queue = createReasoningQueue();
  const state = createNarratorState({
    turn: input.turn,
    ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
    ...(input.lastPick !== undefined ? { lastPick: input.lastPick } : {})
  });
  const quietDelays = input.quietDelaysMs ?? DEFAULT_QUIET_DELAYS_MS;
  const candidateStartedAt = new Map<string, number>();
  const emitted = new Set<string>();
  let closed = false;

  const emitBeat = (beat: NarratorBeat | null, at: number, quiet: boolean): void => {
    if (beat === null) return;
    const text = `**${beat.headline}**\n\n${beat.prose !== undefined ? `${beat.prose}\n\n` : ""}`;
    if (emitted.has(text)) return;
    emitted.add(text);
    queue.push(text);
    state.lastBeatAt = at;
    if (quiet) state.quietStage += 1;
    else state.quietStage = 0;
  };

  const listener = (event: FusionTraceEvent): void => {
    if (closed || event.trace_id !== input.traceId) return;
    const payload = event.payload ?? {};
    if (typeof payload.turn === "number" && payload.turn !== input.turn) return;
    switch (event.event_type) {
      case "session.started": {
        // The per-turn panel kickoff (emitted right before the fan-out).
        if (payload.dialect !== "fusion-step") return;
        emitBeat(narrationBeat(state, { kind: "fanout", roster: rosterOf(payload), at: event.ts }), event.ts, false);
        return;
      }
      case "harness.candidate.started": {
        // Silent: all members start together; the fan-out beat covers it. Only
        // the start time is recorded (for per-candidate elapsed).
        state.sawPanel = true;
        if (event.candidate_id !== undefined) candidateStartedAt.set(event.candidate_id, event.ts);
        return;
      }
      case "harness.candidate.finished": {
        const id = candidateLabel(event);
        if (id === undefined) return;
        const began = event.candidate_id !== undefined ? candidateStartedAt.get(event.candidate_id) : undefined;
        const preview = typeof payload.final_output_preview === "string" ? payload.final_output_preview : undefined;
        const gist = preview !== undefined ? sanitizeGist(preview) : undefined;
        const finish: CandidateFinish = {
          id,
          ok: payload.status === "succeeded",
          ...(typeof payload.finish_reason === "string" ? { finishReason: payload.finish_reason } : {}),
          ...(began !== undefined ? { elapsedMs: event.ts - began } : {}),
          ...(typeof payload.step_count === "number" ? { steps: payload.step_count } : {}),
          ...(gist !== undefined ? { gist } : {})
        };
        emitBeat(narrationBeat(state, { kind: "finish", finish, at: event.ts }), event.ts, false);
        return;
      }
      case "judge.request": {
        emitBeat(
          narrationBeat(state, { kind: "judging", candidates: judgeCandidatesOf(payload), at: event.ts }),
          event.ts,
          false
        );
        return;
      }
      default:
        return;
    }
  };

  // Quiet-beat ticker: when nothing has happened for the current escalation
  // delay, say so once (with fresh elapsed time), then back off further.
  const quietTimer = setInterval(() => {
    if (closed) return;
    const now = Date.now();
    const since = now - (state.lastBeatAt ?? state.startedAt ?? now);
    const delay = quietDelays[Math.min(state.quietStage, quietDelays.length - 1)] ?? Number.POSITIVE_INFINITY;
    if (since < delay) return;
    try {
      emitBeat(narrationBeat(state, { kind: "quiet", at: now }), now, true);
    } catch {
      // narration must never fail a turn
    }
  }, Math.min(QUIET_POLL_MS, ...quietDelays.map((delay) => Math.max(50, Math.floor(delay / 2)))));
  quietTimer.unref();

  addTraceListener(listener);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(quietTimer);
    removeTraceListener(listener);
    queue.end();
  };
  return { events: queue.iterable, close };
}

/**
 * Interleave a turn's runtime events with its narration deltas. Narration flows
 * only until the first `sse.chunk` (the judge's first bytes) — from then on the
 * judge stream is exclusive, so narration can never split or delay real output.
 * The narration channel is always closed on exit.
 */
export async function* mergeEventsWithNarration(
  main: AsyncIterable<RuntimeEvent>,
  narration: TurnNarration
): AsyncGenerator<RuntimeEvent | ReasoningDeltaEvent> {
  const mainIt = main[Symbol.asyncIterator]();
  const sideIt = narration.events[Symbol.asyncIterator]();
  let mainNext = mainIt.next();
  let sideNext: Promise<IteratorResult<ReasoningDeltaEvent>> | undefined = sideIt.next();
  try {
    for (;;) {
      if (sideNext !== undefined) {
        // Narration first in the race: when both are ready (e.g. the judge's
        // first chunk lands right after the "judging..." line was pushed), the
        // pending narration line still goes out before narration shuts off.
        const winner = await Promise.race([
          sideNext.then((result) => ({ source: "side" as const, result })),
          mainNext.then((result) => ({ source: "main" as const, result }))
        ]);
        if (winner.source === "side") {
          const result = winner.result as IteratorResult<ReasoningDeltaEvent>;
          if (result.done === true) {
            sideNext = undefined;
            continue;
          }
          yield result.value;
          sideNext = sideIt.next();
          continue;
        }
        const result = winner.result as IteratorResult<RuntimeEvent>;
        if (result.done === true) return;
        mainNext = mainIt.next();
        if (result.value.type === "sse.chunk") {
          // Judge tokens have started: narration ends here, permanently.
          narration.close();
          sideNext = undefined;
        }
        yield result.value;
        continue;
      }
      const result = await mainNext;
      if (result.done === true) return;
      mainNext = mainIt.next();
      yield result.value;
    }
  } finally {
    narration.close();
  }
}
