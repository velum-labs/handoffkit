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

import { addTraceListener, emitTrace, isProposalK, removeTraceListener } from "@fusionkit/protocol";
import type { FusionTraceEvent } from "@fusionkit/protocol";
import type { RuntimeEvent } from "@fusionkit/kernel";

/** A narration delta for the client stream (serialized as `delta.reasoning_content`). */
export type ReasoningDeltaEvent = { type: "reasoning.delta"; text: string };

/**
 * An optional prose writer for the narration beats (e.g. a small local model).
 * Writers are strictly advisory: the beat engine enforces a time budget,
 * sanitizes every returned sentence, and falls back to the templated prose on
 * timeout, error, or `undefined`. Headlines are never writer-authored — they
 * are the live status ticker and stay templated and deterministic.
 */
export type NarrationWriter = {
  /** One factual sentence about a finished candidate; undefined -> template. */
  candidateGist(
    input: { id: string; finalOutput: string; proposal?: string },
    signal: AbortSignal
  ): Promise<string | undefined>;
  /** One sentence comparing the candidates at judge time; undefined -> template. */
  compareCandidates(
    input: {
      candidates: Array<{
        id: string;
        finalOutput?: string;
        diff?: string;
        verificationStatus?: string;
        /** Rendered terminal proposal, when the candidate ends in one. */
        proposal?: string;
      }>;
    },
    signal: AbortSignal
  ): Promise<string | undefined>;
};

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

// ---- candidate structure (the k-general narration substrate) ---------------
//
// Narration renders the candidate *wire*, not a mode: a candidate may carry
// executed evidence (tool calls with observations, a diff) and may end in a
// terminal proposal (a trailing `function_call` batch with no observation
// after it) or a final answer. Every k produces some mix — k=1 proposals
// only, finite k>1 lookahead evidence plus a proposal, k=∞ evidence plus an
// answer — and these helpers read the structure so the beats never branch on
// mode.

/** One proposed (unexecuted) call from a candidate's terminal batch. */
export type ProposedCall = { name?: string; arguments?: string };

type WireItemLike = { type?: unknown; name?: unknown; arguments?: unknown; text?: unknown };

function wireItems(wire: { items?: unknown }): WireItemLike[] {
  return Array.isArray(wire.items)
    ? wire.items.filter((item): item is WireItemLike => item !== null && typeof item === "object")
    : [];
}

/**
 * The candidate's terminal proposal: the trailing `function_call` batch with
 * nothing executed after it. Trailing empty `message` items (a bounded rollout
 * ends with an empty output marker) are skipped; any observation or non-empty
 * message after a call means the calls were executed, not proposed.
 */
export function terminalProposal(wire: { items?: unknown }): ProposedCall[] {
  const items = wireItems(wire);
  const batch: ProposedCall[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as WireItemLike;
    if (item.type === "message" && batch.length === 0) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text.length === 0) continue; // trailing empty output marker
      break;
    }
    if (item.type === "function_call") {
      batch.unshift({
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {})
      });
      continue;
    }
    break;
  }
  return batch;
}

/** Executed evidence: how many observations (executed tool results) the candidate carries. */
export function executedEvidence(wire: { items?: unknown }): { observations: number } {
  const observations = wireItems(wire).filter((item) => item.type === "function_call_output").length;
  return { observations };
}

/** Compact human rendering of a proposed batch: `get_weather({"city":"Paris"}) + run(...)`. */
export function renderProposal(calls: readonly ProposedCall[], maxLength = 90): string {
  const rendered = calls
    .map((call) => `${call.name ?? "tool"}(${(call.arguments ?? "").replace(/\s+/g, " ")})`)
    .join(" + ");
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength - 1)}…` : rendered;
}

/** Whether two proposed batches are the same step (JSON-normalized arguments). */
export function proposalsAgree(a: readonly ProposedCall[], b: readonly ProposedCall[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const normalize = (call: ProposedCall): string => {
    let args = call.arguments ?? "";
    try {
      args = JSON.stringify(JSON.parse(args === "" ? "{}" : args));
    } catch {
      args = args.replace(/\s+/g, "");
    }
    return `${call.name ?? ""}\u0000${args}`;
  };
  const left = a.map(normalize).sort();
  const right = b.map(normalize).sort();
  return left.every((entry, index) => entry === right[index]);
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
  /** The candidate's terminal proposal, when it ended in one. */
  proposal?: ProposedCall[];
};

/** One judge-time candidate fact sheet (mined from the judge.request payload). */
export type JudgeCandidate = {
  id: string;
  ok: boolean;
  diff?: string;
  verificationStatus?: string;
  finalOutput?: string;
  /** The candidate's terminal proposal, when it ended in one. */
  proposal?: ProposedCall[];
};

export type NarrationTrigger =
  | { kind: "fanout"; roster: Array<{ id: string; model?: string }>; at: number }
  | { kind: "finish"; finish: CandidateFinish; at: number }
  | { kind: "judging"; candidates: JudgeCandidate[]; at: number }
  | { kind: "quiet"; at: number };

export type NarratorState = {
  turn: number;
  judgeModel?: string;
  /** The candidate the judge adopted on the previous fuse (opener color). */
  lastPick?: string;
  /** Rendered step the whole panel proposed last fuse (tie: no single pick). */
  lastAgreed?: string;
  /**
   * The route's k. The fan-out/quiet beats are the only k consumers — they
   * must speak before candidates exist, so structure cannot inform them.
   */
  k?: number;
  /** 1-based fuse round within the turn; headlines prefix "Step N —" when > 1. */
  round?: number;
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
  lastAgreed?: string;
  k?: number;
  round?: number;
}): NarratorState {
  return {
    turn: input.turn,
    ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
    ...(input.lastPick !== undefined ? { lastPick: input.lastPick } : {}),
    ...(input.lastAgreed !== undefined ? { lastAgreed: input.lastAgreed } : {}),
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.round !== undefined ? { round: input.round } : {}),
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
      ? `Last round the judge picked ${state.lastPick} — fanning out again`
      : state.lastAgreed !== undefined
        ? `Last round the panel agreed on ${state.lastAgreed} — fanning out again`
        : count > 0
          ? `Fanning out to ${plural(count, "model")}`
          : "Fanning out to the panel";
  const names = state.roster.map((member) => member.model ?? member.id);
  // The one k-informed copy: candidates don't exist yet, so structure cannot
  // tell us whether members will execute (worktrees) or only propose (k=1).
  const proposing = isProposalK(state.k);
  const prose =
    names.length > 1
      ? proposing
        ? `${joinNames(names)} are each proposing one step.`
        : `${joinNames(names)} are each taking a shot in isolated worktrees.`
      : names.length === 1
        ? proposing
          ? `${names[0]} is proposing one step.`
          : `${names[0]} is taking a shot in an isolated worktree.`
        : undefined;
  return { headline, ...(prose !== undefined ? { prose } : {}) };
}

function renderFinish(state: NarratorState, finish: CandidateFinish): NarratorBeat {
  const ordinal = state.finishes.length;
  const total = state.roster.length;
  const waiting = outstandingIds(state);
  const okCount = state.finishes.filter((entry) => entry.ok).length;

  if (!finish.ok) {
    const verb =
      finish.finishReason === "timeout"
        ? "timed out"
        : finish.finishReason === "straggler_abandoned"
          ? "was dropped (still running after the grace window)"
          : `failed (${finish.finishReason ?? "error"})`;
    const headline =
      waiting.length > 0
        ? `${finish.id} ${verb} — ${joinNames(waiting)} still working`
        : okCount > 0
          ? `${finish.id} ${verb} — judging the ${okCount === 1 ? "1 survivor" : `${okCount} survivors`}`
          : `${finish.id} ${verb}`;
    return { headline };
  }

  // Structural gist: a terminal proposal renders as the concrete step; a
  // final answer renders as its text preview. Executed-evidence facts (steps,
  // elapsed) append whenever present — one rule for every k.
  const gist =
    finish.proposal !== undefined && finish.proposal.length > 0
      ? renderProposal(finish.proposal)
      : finish.gist;
  const gistProse = (subject: string | undefined): string | undefined =>
    gist !== undefined
      ? `${subject !== undefined ? `${subject} proposes` : "Proposes"}: ${gist}${finishFacts(finish)}`
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
  // Structural headline: when every usable candidate ends in a proposal, the
  // judge is selecting a next step; otherwise it compares candidates/survivors.
  const proposers = usable.filter(
    (candidate) => candidate.proposal !== undefined && candidate.proposal.length > 0
  );
  const noun = usable.length > 0 && proposers.length === usable.length ? "proposal" : "candidate";
  const what = hadFailures
    ? `the ${usable.length === 1 ? "1 survivor" : `${usable.length} survivors`}`
    : plural(usable.length, noun);
  const headline = `Judging ${what}${withJudge}`;

  const sentences: string[] = [];
  // Proposal agreement: equality over terminal batches — defined whenever
  // candidates propose, whatever k produced them.
  if (proposers.length >= 2) {
    const [first, ...rest] = proposers;
    const unanimous = rest.every((candidate) =>
      proposalsAgree(first?.proposal ?? [], candidate.proposal ?? [])
    );
    if (unanimous) {
      sentences.push(
        `${joinNames(proposers.map((candidate) => candidate.id))} propose the same step: ` +
          `${renderProposal(first?.proposal ?? [])}.`
      );
    } else {
      for (const candidate of proposers.slice(0, 3)) {
        sentences.push(`${candidate.id} proposes ${renderProposal(candidate.proposal ?? [], 70)}.`);
      }
    }
  } else if (proposers.length === 1 && usable.length > 1) {
    const proposer = proposers[0];
    const texters = usable.filter((candidate) => candidate !== proposer).map((candidate) => candidate.id);
    sentences.push(
      `${proposer?.id} proposes ${renderProposal(proposer?.proposal ?? [], 70)}; ` +
        `${joinNames(texters)} answer${texters.length === 1 ? "s" : ""} in text.`
    );
  }
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
  const verb = isProposalK(state.k) ? "Still proposing" : "Still working";
  return { headline: `${verb}${who}${elapsed}` };
}

/**
 * Apply a trigger to the narrator state and render the beat it warrants (or
 * null for silence). Pure apart from mutating `state` — deterministic and
 * directly unit-testable.
 */
export function narrationBeat(state: NarratorState, trigger: NarrationTrigger): NarratorBeat | null {
  state.startedAt ??= trigger.at;
  const beat = ((): NarratorBeat | null => {
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
        const rendered = renderJudging(state, trigger.candidates);
        state.phase = "judging";
        return rendered;
      }
      case "quiet":
        return renderQuiet(state, trigger.at);
      default: {
        const exhaustive: never = trigger;
        throw new Error(`unknown narration trigger: ${String(exhaustive)}`);
      }
    }
  })();
  // Round ordinal: rounds exist for every k (k = ∞ trivially has one per
  // turn), so the prefix self-suppresses exactly where rounds don't repeat.
  if (beat !== null && state.round !== undefined && state.round > 1) {
    beat.headline = `Step ${state.round} — ${beat.headline}`;
  }
  return beat;
}

// ---- the live narrator ------------------------------------------------------

export type TurnNarratorInput = {
  /** The session trace id: only this session's events are narrated. */
  traceId: string;
  /** The 1-based user-turn index: other turns' events are ignored. */
  turn: number;
  /** The configured judge model name, for the judging headline. */
  judgeModel?: string;
  /** The candidate the judge adopted on the previous fuse (opener color). */
  lastPick?: string;
  /** Rendered step the whole panel proposed last fuse (tie opener). */
  lastAgreed?: string;
  /** The route's k — consumed only by the fan-out/quiet phase copy. */
  k?: number;
  /** 1-based fuse round within the turn (headlines prefix "Step N —" when > 1). */
  round?: number;
  /** Quiet-beat escalation delays; injectable for tests. */
  quietDelaysMs?: readonly number[];
  /** Optional prose writer (e.g. a small local model); advisory only. */
  writer?: NarrationWriter;
  /** Per-writer-call time budget before falling back to the template. */
  writerTimeoutMs?: number;
};

const DEFAULT_QUIET_DELAYS_MS: readonly number[] = [25_000, 60_000, 120_000];
const QUIET_POLL_MS = 5_000;
const DEFAULT_WRITER_TIMEOUT_MS = 400;
/** Length cap for a writer-authored comparison sentence (longer than a gist). */
const COMPARISON_MAX_LENGTH = 160;

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
      const proposal = terminalProposal(wire);
      return {
        id,
        ok: wire.status !== "failed",
        ...(typeof wire.diff === "string" ? { diff: wire.diff } : {}),
        ...(typeof verification?.status === "string" ? { verificationStatus: verification.status } : {}),
        ...(typeof wire.final_output === "string" ? { finalOutput: wire.final_output } : {}),
        ...(proposal.length > 0 ? { proposal } : {})
      };
    });
}

/** Mine a finished-event `proposed_calls` payload into proposed calls. */
function proposedCallsOf(payload: Record<string, unknown>): ProposedCall[] {
  if (!Array.isArray(payload.proposed_calls)) return [];
  return payload.proposed_calls
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(typeof entry.arguments_preview === "string" ? { arguments: entry.arguments_preview } : {})
    }));
}

/**
 * Subscribe to the in-process trace stream and narrate one turn as beats. Each
 * beat renders as a bold markdown headline (Codex's live status header — its
 * TUI hides reasoning without bold markers) plus an optional prose sentence.
 *
 * All beat work runs on one serialized chain, so beats always emit in event
 * order even when an optional {@link NarrationWriter} is consulted for prose.
 * A writer call is bounded by `writerTimeoutMs`; on timeout/error/undefined the
 * templated prose ships instead, so a slow or broken writer can only ever make
 * a beat later (by the budget) or plainer, never wrong, missing, or reordered.
 */
export function createTurnNarrator(input: TurnNarratorInput): TurnNarration {
  const queue = createReasoningQueue();
  const state = createNarratorState({
    turn: input.turn,
    ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
    ...(input.lastPick !== undefined ? { lastPick: input.lastPick } : {}),
    ...(input.lastAgreed !== undefined ? { lastAgreed: input.lastAgreed } : {}),
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.round !== undefined ? { round: input.round } : {})
  });
  const quietDelays = input.quietDelaysMs ?? DEFAULT_QUIET_DELAYS_MS;
  const writer = input.writer;
  const writerTimeoutMs = input.writerTimeoutMs ?? DEFAULT_WRITER_TIMEOUT_MS;
  const candidateStartedAt = new Map<string, number>();
  const emitted = new Set<string>();
  const closeController = new AbortController();
  let closed = false;
  // The serialized beat pipeline: state mutation + writer calls + emission all
  // happen here, in event order. Tasks already enqueued when close() fires
  // still flush (their writer calls are aborted, so they fall back to the
  // template quickly); pushes after the queue ends are no-ops.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => void | Promise<void>): void => {
    chain = chain
      .then(async () => {
        await task();
      })
      .catch(() => {
        // narration must never fail a turn
      });
  };

  /**
   * Run one writer call within the time budget. Resolves undefined on timeout,
   * abort, or error — even when the writer ignores its abort signal.
   */
  const withBudget = (
    call: (signal: AbortSignal) => Promise<string | undefined>
  ): Promise<string | undefined> => {
    const signal = AbortSignal.any([closeController.signal, AbortSignal.timeout(writerTimeoutMs)]);
    const expired = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), writerTimeoutMs + 50);
      timer.unref();
    });
    return Promise.race([call(signal).catch(() => undefined), expired]);
  };

  const emitBeat = (beat: NarratorBeat | null, at: number, quiet: boolean): void => {
    if (beat === null) return;
    const text = `**${beat.headline}**\n\n${beat.prose !== undefined ? `${beat.prose}\n\n` : ""}`;
    if (emitted.has(text)) return;
    emitted.add(text);
    queue.push(text);
    // Mirror the beat onto the trace stream so the observability dashboard
    // shows the narration alongside the run (fire-and-forget, never blocking).
    emitTrace({
      component: "gateway",
      event_type: "log",
      traceId: input.traceId,
      payload: {
        kind: "narration.beat",
        turn: input.turn,
        headline: beat.headline,
        ...(beat.prose !== undefined ? { prose: beat.prose } : {})
      }
    });
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
        const roster = rosterOf(payload);
        enqueue(() => emitBeat(narrationBeat(state, { kind: "fanout", roster, at: event.ts }), event.ts, false));
        return;
      }
      case "harness.candidate.started": {
        // Silent: all members start together; the fan-out beat covers it. Only
        // the start time is recorded (for per-candidate elapsed). The sawPanel
        // mutation rides the chain so it cannot overtake a pending fan-out beat.
        if (event.candidate_id !== undefined) candidateStartedAt.set(event.candidate_id, event.ts);
        enqueue(() => {
          state.sawPanel = true;
        });
        return;
      }
      case "harness.candidate.finished": {
        const id = candidateLabel(event);
        if (id === undefined) return;
        const began = event.candidate_id !== undefined ? candidateStartedAt.get(event.candidate_id) : undefined;
        const preview = typeof payload.final_output_preview === "string" ? payload.final_output_preview : undefined;
        const proposal = proposedCallsOf(payload);
        const ok = payload.status === "succeeded";
        enqueue(async () => {
          // The writer sees the raw preview; its sentence (and the fallback)
          // both pass through the sanitize gate before entering the channel.
          let gist = preview !== undefined ? sanitizeGist(preview) : undefined;
          if (writer !== undefined && ok && (preview !== undefined || proposal.length > 0)) {
            const written = await withBudget((signal) =>
              writer.candidateGist(
                {
                  id,
                  finalOutput: preview ?? "",
                  ...(proposal.length > 0 ? { proposal: renderProposal(proposal, 200) } : {})
                },
                signal
              )
            );
            const sanitized = written !== undefined ? sanitizeGist(written) : undefined;
            if (sanitized !== undefined) gist = sanitized;
          }
          const finish: CandidateFinish = {
            id,
            ok,
            ...(typeof payload.finish_reason === "string" ? { finishReason: payload.finish_reason } : {}),
            ...(began !== undefined ? { elapsedMs: event.ts - began } : {}),
            ...(typeof payload.step_count === "number" ? { steps: payload.step_count } : {}),
            ...(gist !== undefined ? { gist } : {}),
            ...(proposal.length > 0 ? { proposal } : {})
          };
          emitBeat(narrationBeat(state, { kind: "finish", finish, at: event.ts }), event.ts, false);
        });
        return;
      }
      case "judge.request": {
        const candidates = judgeCandidatesOf(payload);
        enqueue(async () => {
          const beat = narrationBeat(state, { kind: "judging", candidates, at: event.ts });
          if (beat !== null && writer !== undefined && candidates.length > 0) {
            const written = await withBudget((signal) =>
              writer.compareCandidates(
                {
                  candidates: candidates.map(({ id, finalOutput, diff, verificationStatus, proposal }) => ({
                    id,
                    ...(finalOutput !== undefined ? { finalOutput } : {}),
                    ...(diff !== undefined ? { diff } : {}),
                    ...(verificationStatus !== undefined ? { verificationStatus } : {}),
                    ...(proposal !== undefined && proposal.length > 0
                      ? { proposal: renderProposal(proposal, 200) }
                      : {})
                  }))
                },
                signal
              )
            );
            const sanitized = written !== undefined ? sanitizeGist(written, COMPARISON_MAX_LENGTH) : undefined;
            if (sanitized !== undefined) beat.prose = sanitized;
          }
          emitBeat(beat, event.ts, false);
        });
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
    enqueue(() => emitBeat(narrationBeat(state, { kind: "quiet", at: now }), now, true));
  }, Math.min(QUIET_POLL_MS, ...quietDelays.map((delay) => Math.max(50, Math.floor(delay / 2)))));
  quietTimer.unref();

  addTraceListener(listener);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(quietTimer);
    removeTraceListener(listener);
    // Abort any in-flight writer call so the chain settles promptly, flush the
    // already-enqueued beats (template fallback), then end the queue.
    closeController.abort();
    void chain.finally(() => queue.end());
  };
  return { events: queue.iterable, close };
}

/**
 * Whether a fuse-stream SSE chunk carries real judge output (content, reasoning,
 * tool calls, a finish, or an error). The Python step endpoint yields an empty
 * role-announce chunk the instant the POST connects — closing narration on that
 * handshake would drop any beat still in flight (most visibly the "judging"
 * beat, rendered milliseconds earlier), so the merge only closes on payload.
 */
export function sseChunkHasPayload(data: string): boolean {
  for (const line of data.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0 || trimmed.startsWith(":")) continue; // blank / keepalive comment
    if (!trimmed.startsWith("data: ")) return true; // anything unrecognized counts as payload
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(6));
    } catch {
      // [DONE] or non-JSON data — assume payload; never risk splitting output.
      return true;
    }
    if (parsed === null || typeof parsed !== "object") return true;
    const frame = parsed as { error?: unknown; choices?: Array<Record<string, unknown>> };
    if (frame.error !== undefined) return true;
    for (const choice of frame.choices ?? []) {
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) return true;
      const delta = choice.delta;
      if (delta === null || typeof delta !== "object") return true;
      if (Object.keys(delta).some((key) => key !== "role")) return true;
    }
  }
  return false;
}

/**
 * Interleave a turn's runtime events with its narration deltas. Narration flows
 * only until the first `sse.chunk` with payload (the judge's first real bytes;
 * the empty role-announce handshake doesn't count) — from then on the judge
 * stream is exclusive, so narration can never split or delay real output.
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
        if (result.value.type === "sse.chunk" && sseChunkHasPayload(result.value.data)) {
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
