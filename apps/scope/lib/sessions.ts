import { attrBool, attrJson, attrNum, attrStr, attrStrArray, candidateIdOf, modelIdOf } from "./types";
import type { AttributeSource, RawEnvironment, StoredEvent, StoredSpan } from "./types";

/**
 * Pure aggregation: fold a session's spans and events into the structured
 * view the dashboard renders (environment, per-candidate trajectories, the
 * judge's thinking-to-final flow, and panel-model calls). Kept
 * dependency-free so it can be unit tested directly.
 */

export type TrajectoryStepView = {
  index: number;
  type: string;
  text?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_input?: string;
  is_error?: boolean;
};

export type CandidateView = {
  candidateId: string;
  modelId?: string;
  model?: string;
  status?: string;
  branchName?: string;
  worktreePath?: string;
  steps: TrajectoryStepView[];
  toolCallCount?: number;
  finishReason?: string;
  verificationStatus?: string;
  finalOutputPreview?: string;
  /** Full system prompt the panel model ran under (model-call started event). */
  systemPrompt?: string;
  /** Full task prompt sent to the panel model (model-call started event). */
  prompt?: string;
  /** Full final output of the panel model (the chat span). */
  finalOutput?: string;
  usage?: Record<string, unknown>;
  /** User-turn index this candidate belongs to (a follow-up is a new turn). */
  turn?: number;
};

export type ModelCallView = {
  spanId: string;
  modelId?: string;
  candidateId?: string;
  provider?: string;
  model?: string;
  status: "running" | "succeeded" | "failed";
  latencyS?: number;
  finishReason?: string;
  usage?: Record<string, unknown>;
  contentPreview?: string;
  error?: string;
  ts: number;
  /** User-turn index the call belongs to, when the emitter carried one. */
  turn?: number;
};

export type JudgeView = {
  /** The full input handed to the judge (the fusion.judge.request event). */
  prompt?: {
    judgeModel?: string;
    messages?: unknown;
    trajectories?: unknown;
    tools?: unknown;
    trajectoryIds?: string[];
  };
  thinking?: { fusionUnit?: string; raw?: string; usage?: Record<string, unknown> };
  scored?: { fusionUnit?: string; analysis?: Record<string, unknown>; metrics?: Record<string, unknown>; inputIds?: string[] };
  synthesis?: { raw?: string; empty?: boolean; usage?: Record<string, unknown> };
  final?: {
    decision?: string;
    rationale?: string;
    finalOutput?: string;
    content?: string;
    usage?: Record<string, unknown>;
    selectedCandidateId?: string;
    record?: Record<string, unknown>;
  };
};

/**
 * One judge step = one `fusion.judge` span (one gateway fuse phase): the input
 * event plus its outcome (an intermediate tool-calling turn or the terminal
 * answer). Multiple steps share a `turn` when they belong to the same user
 * message; a follow-up user message is a new `turn`.
 */
export type JudgeStepView = {
  spanId: string;
  turn?: number;
  ts: number;
  kind: "intermediate" | "final" | "pending";
  prompt?: JudgeView["prompt"];
  thinking?: { raw?: string; toolCalls?: unknown; usage?: Record<string, unknown> };
  final?: {
    finalOutput?: string;
    content?: string;
    decision?: string;
    rationale?: string;
    selectedCandidateId?: string;
    usage?: Record<string, unknown>;
  };
};

export type EnvironmentView = {
  repo?: string;
  fusionBackendUrl?: string;
  harnesses?: string[];
  judgeModel?: string | null;
  models?: Array<{ id: string; model: string; endpoint_id?: string; provider?: string }>;
  modelEndpoints?: Record<string, string>;
};

/** One reasoning-trace narration beat, as streamed to the coding agent. */
export type NarrationBeatView = {
  ts: number;
  turn?: number;
  headline: string;
  prose?: string;
};

export type SessionDetail = {
  traceId: string;
  status: string;
  startedAt: number;
  lastTs: number;
  dialect?: string;
  promptPreview?: string;
  /** Full first-turn prompt, recovered from model-call/judge inputs. */
  prompt?: string;
  environment?: EnvironmentView;
  candidates: CandidateView[];
  modelCalls: ModelCallView[];
  judge: JudgeView;
  /** Per-step judge history (ordered), so multi-turn sessions don't collapse. */
  judgeSteps: JudgeStepView[];
  /** The reasoning-trace narration, in the order the coding agent saw it. */
  narration: NarrationBeatView[];
  /** Total resolved spend for the session (fusion.cost events). */
  costUsd?: number;
  /** True when at least one cost entry could not be priced. */
  costIncomplete?: boolean;
  finalOutput?: string;
  evidence?: string[];
  durationMs: number;
  spanCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  spans: StoredSpan[];
  events: StoredEvent[];
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Recover the user's prompt text from a chat-message array (string or parts content). */
function firstUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const entry = obj(message);
    if (entry.role !== "user") continue;
    if (typeof entry.content === "string") return entry.content;
    if (Array.isArray(entry.content)) {
      const texts = entry.content
        .map((part) => {
          const p = obj(part);
          return typeof p.text === "string" ? p.text : undefined;
        })
        .filter((text): text is string => text !== undefined);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return undefined;
}

function usageOf(source: AttributeSource): Record<string, unknown> | undefined {
  return attrJson<Record<string, unknown>>(source, "fusion.usage");
}

/** Group name for span counters: chat spans collapse onto "chat". */
function countName(name: string): string {
  return name.startsWith("chat ") ? "chat" : name;
}

export function deriveSession(traceId: string, spans: StoredSpan[], events: StoredEvent[] = []): SessionDetail {
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id);
  const sortedEvents = [...events].sort((a, b) => a.ts_ms - b.ts_ms || a.id - b.id);
  const candidates = new Map<string, CandidateView>();
  const modelCalls = new Map<string, ModelCallView>();
  const judge: JudgeView = {};
  const judgeStepMap = new Map<string, JudgeStepView>();
  const narration: NarrationBeatView[] = [];
  const spanCounts: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};

  // Ancestor resolution: events attach judge activity to their enclosing
  // fusion.judge span, starting from the event's owning span (the Python
  // engine's events sit one level deeper, under its fusion.fuse span).
  const byId = new Map<string, StoredSpan>();
  for (const span of sorted) byId.set(span.span_id, span);
  const enclosingJudgeSpan = (spanId: string | undefined): string => {
    let current: StoredSpan | undefined = spanId !== undefined ? byId.get(spanId) : undefined;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.span_id)) {
      if (current.name === "fusion.judge") return current.span_id;
      seen.add(current.span_id);
      current = current.parent_span_id !== undefined ? byId.get(current.parent_span_id) : undefined;
    }
    // No gateway judge span in scope (e.g. a directly-driven fuse step): fall
    // back to the nearest fuse span, else the event's own span.
    current = spanId !== undefined ? byId.get(spanId) : undefined;
    while (current !== undefined) {
      if (current.name === "fusion.fuse") return current.span_id;
      current = current.parent_span_id !== undefined ? byId.get(current.parent_span_id) : undefined;
    }
    return spanId ?? "";
  };

  const ensureStep = (spanId: string, ts: number): JudgeStepView => {
    let step = judgeStepMap.get(spanId);
    if (step === undefined) {
      step = { spanId, ts, kind: "pending" };
      judgeStepMap.set(spanId, step);
    }
    return step;
  };

  let status = "running";
  let dialect: string | undefined;
  let promptPreview: string | undefined;
  let prompt: string | undefined;
  let environment: EnvironmentView | undefined;
  let finalOutput: string | undefined;
  let evidence: string[] | undefined;
  let costUsd: number | undefined;
  let costIncomplete: boolean | undefined;
  let sawGatewayJudge = false;

  const ensureCandidate = (id: string): CandidateView => {
    let candidate = candidates.get(id);
    if (candidate === undefined) {
      candidate = { candidateId: id, steps: [] };
      candidates.set(id, candidate);
    }
    return candidate;
  };

  const applyEnvironment = (source: AttributeSource): void => {
    dialect = attrStr(source, "fusion.dialect") ?? dialect;
    promptPreview = attrStr(source, "fusion.prompt_preview") ?? promptPreview;
    const env = attrJson<RawEnvironment>(source, "fusion.environment");
    if (env !== undefined) {
      environment = {
        repo: env.repo,
        fusionBackendUrl: env.fusion_backend_url,
        harnesses: env.harnesses,
        judgeModel: env.judge_model ?? undefined,
        models: env.models,
        modelEndpoints: env.model_endpoints
      };
    }
  };

  const applyJudgeFinal = (span: StoredSpan): void => {
    const final = {
      decision: attrStr(span, "fusion.decision"),
      rationale: attrStr(span, "fusion.rationale"),
      finalOutput: attrStr(span, "fusion.final_output"),
      content: attrStr(span, "fusion.content"),
      usage: usageOf(span),
      selectedCandidateId: attrStr(span, "fusion.selected.trajectory_id"),
      record: attrJson<Record<string, unknown>>(span, "fusion.synthesis")
    };
    judge.final = final;
    const judgeFinal = final.finalOutput ?? final.content;
    if (judgeFinal !== undefined) finalOutput = judgeFinal;
    if (status === "running" && span.status !== "error") status = "succeeded";
    const step = ensureStep(span.span_id, span.end_ms);
    step.kind = "final";
    step.turn = attrNum(span, "fusion.turn") ?? step.turn;
    step.final = final;
  };

  const foldSpan = (span: StoredSpan): void => {
    const key = countName(span.name);
    spanCounts[key] = (spanCounts[key] ?? 0) + 1;
    const candidateId = candidateIdOf(span);

    if (span.name === "fusion.run" || span.name === "fusion.passthrough") {
      applyEnvironment(span);
      status = attrStr(span, "fusion.status") ?? status;
      finalOutput = attrStr(span, "fusion.final_output_preview") ?? finalOutput;
      const runEvidence = attrJson<string[]>(span, "fusion.evidence");
      if (Array.isArray(runEvidence)) evidence = runEvidence;
    } else if (span.name === "fusion.candidate") {
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.modelId = attrStr(span, "fusion.model.id") ?? candidate.modelId;
        candidate.model = attrStr(span, "gen_ai.request.model") ?? candidate.model;
        candidate.status = attrStr(span, "fusion.status") ?? candidate.status;
        candidate.turn = attrNum(span, "fusion.turn") ?? candidate.turn;
        candidate.toolCallCount = attrNum(span, "fusion.tool_call_count") ?? candidate.toolCallCount;
        candidate.finishReason = attrStr(span, "fusion.finish_reason") ?? candidate.finishReason;
        candidate.verificationStatus = attrStr(span, "fusion.verification_status") ?? candidate.verificationStatus;
        candidate.finalOutputPreview = attrStr(span, "fusion.final_output_preview") ?? candidate.finalOutputPreview;
        candidate.branchName = attrStr(span, "fusion.branch_name") ?? candidate.branchName;
        candidate.worktreePath = attrStr(span, "fusion.worktree_path") ?? candidate.worktreePath;
      }
    } else if (span.name.startsWith("chat")) {
      const usage = usageOf(span);
      const existing = modelCalls.get(span.span_id);
      const latency =
        typeof usage?.latency_s === "number" ? usage.latency_s : (span.end_ms - span.start_ms) / 1000;
      modelCalls.set(span.span_id, {
        spanId: span.span_id,
        modelId: modelIdOf(span) ?? existing?.modelId,
        candidateId: candidateId ?? existing?.candidateId,
        provider: attrStr(span, "gen_ai.provider.name") ?? existing?.provider,
        model: attrStr(span, "gen_ai.request.model") ?? existing?.model,
        status: span.status === "error" ? "failed" : "succeeded",
        latencyS: latency,
        turn: attrNum(span, "fusion.turn") ?? existing?.turn,
        finishReason: attrStr(span, "fusion.finish_reason") ?? existing?.finishReason,
        usage: usage ?? existing?.usage,
        contentPreview: attrStr(span, "fusion.content") ?? existing?.contentPreview,
        error: attrStr(span, "fusion.error") ?? span.status_message,
        ts: existing?.ts ?? span.start_ms
      });
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.finalOutput = attrStr(span, "fusion.final_output") ?? candidate.finalOutput;
        if (usage !== undefined) candidate.usage = usage;
      }
    } else if (span.name === "fusion.judge") {
      sawGatewayJudge = true;
      applyJudgeFinal(span);
    } else if (span.name === "fusion.fuse") {
      // Server-side fuse execution: only authoritative when no gateway judge
      // span covers this session (e.g. the fuse endpoint driven directly).
      if (!sawGatewayJudge && attrBool(span, "fusion.terminal") === true) {
        applyJudgeFinal(span);
      }
    }
  };

  const foldEvent = (event: StoredEvent): void => {
    eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
    const candidateId = candidateIdOf(event);

    if (event.name === "fusion.turn.info") {
      applyEnvironment(event);
    } else if (event.name === "fusion.candidate.started") {
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.modelId = attrStr(event, "fusion.model.id") ?? candidate.modelId;
        candidate.model = attrStr(event, "gen_ai.request.model") ?? candidate.model;
        candidate.turn = attrNum(event, "fusion.turn") ?? candidate.turn;
        candidate.branchName = attrStr(event, "fusion.branch_name") ?? candidate.branchName;
        candidate.worktreePath = attrStr(event, "fusion.worktree_path") ?? candidate.worktreePath;
      }
    } else if (event.name === "fusion.candidate.step") {
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.modelId = candidate.modelId ?? attrStr(event, "fusion.model.id");
        const step = attrJson<TrajectoryStepView>(event, "fusion.step");
        if (step !== undefined && typeof step.index === "number" && typeof step.type === "string") {
          candidate.steps.push(step);
        }
      }
    } else if (event.name === "fusion.model_call.started") {
      // The live start event: prompts + a running call keyed by its owning
      // chat span (which arrives when the call finishes).
      const callSpanId = event.span_id ?? `event-${event.id}`;
      const existing = modelCalls.get(callSpanId);
      const base: ModelCallView = {
        spanId: callSpanId,
        modelId: modelIdOf(event),
        ...(candidateId !== undefined ? { candidateId } : {}),
        provider: attrStr(event, "gen_ai.provider.name"),
        model: attrStr(event, "gen_ai.request.model"),
        status: "running",
        ts: event.ts_ms,
        turn: attrNum(event, "fusion.turn")
      };
      if (existing === undefined) {
        modelCalls.set(callSpanId, base);
      } else {
        modelCalls.set(callSpanId, {
          ...existing,
          modelId: existing.modelId ?? base.modelId,
          candidateId: existing.candidateId ?? base.candidateId,
          provider: existing.provider ?? base.provider,
          model: existing.model ?? base.model,
          turn: existing.turn ?? base.turn,
          ts: Math.min(existing.ts, base.ts)
        });
      }
      if (prompt === undefined) prompt = attrStr(event, "fusion.prompt");
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.systemPrompt = attrStr(event, "fusion.system_prompt") ?? candidate.systemPrompt;
        candidate.prompt = attrStr(event, "fusion.prompt") ?? candidate.prompt;
      }
    } else if (event.name === "fusion.judge.request") {
      const messages = attrJson<unknown>(event, "fusion.messages");
      if (prompt === undefined) prompt = firstUserMessage(messages);
      judge.prompt = {
        judgeModel: attrStr(event, "fusion.judge.model"),
        messages,
        trajectories: attrJson<unknown>(event, "fusion.trajectories"),
        tools: attrJson<unknown>(event, "fusion.tools"),
        trajectoryIds: attrStrArray(event, "fusion.trajectory_ids")
      };
      const step = ensureStep(enclosingJudgeSpan(event.span_id), event.ts_ms);
      step.prompt = judge.prompt;
      step.turn = attrNum(event, "fusion.turn") ?? step.turn;
    } else if (event.name === "fusion.judge.thinking") {
      const raw = attrStr(event, "fusion.raw_analysis");
      judge.thinking = {
        fusionUnit: attrStr(event, "fusion.fusion_unit"),
        raw,
        usage: usageOf(event)
      };
      const step = ensureStep(enclosingJudgeSpan(event.span_id), event.ts_ms);
      if (step.kind === "pending") step.kind = "intermediate";
      step.turn = attrNum(event, "fusion.turn") ?? step.turn;
      step.thinking = {
        raw,
        toolCalls: attrJson<unknown>(event, "fusion.tool_calls"),
        usage: usageOf(event)
      };
    } else if (event.name === "fusion.judge.scored") {
      judge.scored = {
        fusionUnit: attrStr(event, "fusion.fusion_unit"),
        analysis: attrJson<Record<string, unknown>>(event, "fusion.analysis"),
        metrics: attrJson<Record<string, unknown>>(event, "fusion.metrics"),
        inputIds: attrStrArray(event, "fusion.input_ids")
      };
    } else if (event.name === "fusion.judge.synthesis") {
      judge.synthesis = {
        raw: attrStr(event, "fusion.raw_output"),
        empty: attrBool(event, "fusion.synthesis_empty") === true,
        usage: usageOf(event)
      };
    } else if (event.name === "fusion.narration") {
      const headline = attrStr(event, "fusion.headline");
      if (headline !== undefined) {
        narration.push({
          ts: event.ts_ms,
          headline,
          ...(attrNum(event, "fusion.turn") !== undefined ? { turn: attrNum(event, "fusion.turn") } : {}),
          ...(attrStr(event, "fusion.prose") !== undefined ? { prose: attrStr(event, "fusion.prose") } : {})
        });
      }
    } else if (event.name === "fusion.cost") {
      costUsd = (costUsd ?? 0) + (attrNum(event, "fusion.cost.turn_usd") ?? 0);
      if (attrBool(event, "fusion.cost.unknown") === true) costIncomplete = true;
    }
  };

  // Fold spans and events as one time-ordered sequence, so order-dependent
  // derivations (status transitions, first-wins prompts) see the same
  // interleaving the run produced.
  const signals: Array<{ ts: number; span?: StoredSpan; event?: StoredEvent }> = [
    ...sorted.map((span) => ({ ts: span.start_ms, span })),
    ...sortedEvents.map((event) => ({ ts: event.ts_ms, event }))
  ].sort((a, b) => a.ts - b.ts);
  for (const signal of signals) {
    if (signal.span !== undefined) foldSpan(signal.span);
    else if (signal.event !== undefined) foldEvent(signal.event);
  }

  for (const candidate of candidates.values()) {
    candidate.steps.sort((a, b) => a.index - b.index);
  }

  const firstSignalTs = signals.length > 0 ? signals[0].ts : 0;
  const startedAt = sorted.length > 0 ? Math.min(sorted[0].start_ms, firstSignalTs) : firstSignalTs;
  const lastTs = signals.reduce((max, signal) => Math.max(max, signal.span?.end_ms ?? signal.ts), startedAt);

  return {
    traceId,
    status,
    startedAt,
    lastTs,
    ...(dialect !== undefined ? { dialect } : {}),
    ...(promptPreview !== undefined ? { promptPreview } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(environment !== undefined ? { environment } : {}),
    candidates: [...candidates.values()],
    modelCalls: [...modelCalls.values()].sort((a, b) => a.ts - b.ts),
    judge,
    judgeSteps: [...judgeStepMap.values()].sort((a, b) => a.ts - b.ts),
    narration: narration.sort((a, b) => a.ts - b.ts),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costIncomplete !== undefined ? { costIncomplete } : {}),
    ...(finalOutput !== undefined ? { finalOutput } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    durationMs: Math.max(0, lastTs - startedAt),
    spanCounts,
    eventCounts,
    spans: sorted,
    events: sortedEvents
  };
}
