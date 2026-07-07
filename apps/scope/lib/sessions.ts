import { attrBool, attrJson, attrNum, attrStr, attrStrArray, candidateIdOf, isMarker, modelIdOf } from "./types";
import type { RawEnvironment, StoredSpan } from "./types";

/**
 * Pure aggregation: fold a session's spans into the structured view the
 * dashboard renders (environment, per-candidate trajectories, the judge's
 * thinking-to-final flow, and panel-model calls). Kept dependency-free so it
 * can be unit tested directly.
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
  /** Full system prompt the panel model ran under (model-call started marker). */
  systemPrompt?: string;
  /** Full task prompt sent to the panel model (model-call started marker). */
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
  /** The full input handed to the judge (the fusion.judge.request marker). */
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
 * marker plus its outcome (an intermediate tool-calling turn or the terminal
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
  /** Total resolved spend for the session (fusion.cost markers). */
  costUsd?: number;
  /** True when at least one cost entry could not be priced. */
  costIncomplete?: boolean;
  finalOutput?: string;
  evidence?: string[];
  durationMs: number;
  spanCounts: Record<string, number>;
  spans: StoredSpan[];
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

function usageOf(span: StoredSpan): Record<string, unknown> | undefined {
  return attrJson<Record<string, unknown>>(span, "fusion.usage");
}

/** Group name for span counters: chat spans collapse onto "chat". */
function countName(name: string): string {
  return name.startsWith("chat ") ? "chat" : name;
}

export function deriveSession(traceId: string, spans: StoredSpan[]): SessionDetail {
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id);
  const candidates = new Map<string, CandidateView>();
  const modelCalls = new Map<string, ModelCallView>();
  const judge: JudgeView = {};
  const judgeStepMap = new Map<string, JudgeStepView>();
  const narration: NarrationBeatView[] = [];
  const spanCounts: Record<string, number> = {};

  // Ancestor resolution: markers attach judge activity to their enclosing
  // fusion.judge span (the Python engine's markers sit one level deeper,
  // under its fusion.fuse span).
  const byId = new Map<string, StoredSpan>();
  for (const span of sorted) byId.set(span.span_id, span);
  const enclosingJudgeSpan = (span: StoredSpan): string => {
    let current: StoredSpan | undefined = span;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.span_id)) {
      if (current.name === "fusion.judge") return current.span_id;
      seen.add(current.span_id);
      current = current.parent_span_id !== undefined ? byId.get(current.parent_span_id) : undefined;
    }
    // No gateway judge span in scope (e.g. a directly-driven fuse step): fall
    // back to the nearest fuse span, else the marker's own span.
    current = span;
    while (current !== undefined) {
      if (current.name === "fusion.fuse") return current.span_id;
      current = current.parent_span_id !== undefined ? byId.get(current.parent_span_id) : undefined;
    }
    return span.parent_span_id ?? span.span_id;
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

  const applyEnvironment = (span: StoredSpan): void => {
    dialect = attrStr(span, "fusion.dialect") ?? dialect;
    promptPreview = attrStr(span, "fusion.prompt_preview") ?? promptPreview;
    const env = attrJson<RawEnvironment>(span, "fusion.environment");
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

  for (const span of sorted) {
    const key = countName(span.name);
    spanCounts[key] = (spanCounts[key] ?? 0) + 1;
    const candidateId = candidateIdOf(span);

    if (span.name === "fusion.turn.info") {
      applyEnvironment(span);
    } else if (span.name === "fusion.run" || span.name === "fusion.passthrough") {
      applyEnvironment(span);
      status = attrStr(span, "fusion.status") ?? status;
      finalOutput = attrStr(span, "fusion.final_output_preview") ?? finalOutput;
      const runEvidence = attrJson<string[]>(span, "fusion.evidence");
      if (Array.isArray(runEvidence)) evidence = runEvidence;
    } else if (span.name === "fusion.candidate.started") {
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.modelId = attrStr(span, "fusion.model.id") ?? candidate.modelId;
        candidate.model = attrStr(span, "gen_ai.request.model") ?? candidate.model;
        candidate.turn = attrNum(span, "fusion.turn") ?? candidate.turn;
        candidate.branchName = attrStr(span, "fusion.branch_name") ?? candidate.branchName;
        candidate.worktreePath = attrStr(span, "fusion.worktree_path") ?? candidate.worktreePath;
      }
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
    } else if (span.name === "fusion.candidate.step") {
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.modelId = candidate.modelId ?? attrStr(span, "fusion.model.id");
        const step = attrJson<TrajectoryStepView>(span, "fusion.step");
        if (step !== undefined && typeof step.index === "number" && typeof step.type === "string") {
          candidate.steps.push(step);
        }
      }
    } else if (span.name === "fusion.model_call.started") {
      // The live start marker: prompts + a running call keyed by the parent
      // chat span (which arrives when the call finishes).
      const callSpanId = span.parent_span_id ?? span.span_id;
      const existing = modelCalls.get(callSpanId);
      const base: ModelCallView = {
        spanId: callSpanId,
        modelId: modelIdOf(span),
        ...(candidateId !== undefined ? { candidateId } : {}),
        provider: attrStr(span, "gen_ai.provider.name"),
        model: attrStr(span, "gen_ai.request.model"),
        status: "running",
        ts: span.start_ms,
        turn: attrNum(span, "fusion.turn")
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
      if (prompt === undefined) prompt = attrStr(span, "fusion.prompt");
      if (candidateId !== undefined) {
        const candidate = ensureCandidate(candidateId);
        candidate.systemPrompt = attrStr(span, "fusion.system_prompt") ?? candidate.systemPrompt;
        candidate.prompt = attrStr(span, "fusion.prompt") ?? candidate.prompt;
      }
    } else if (span.name.startsWith("chat")) {
      const usage = usageOf(span);
      const existing = modelCalls.get(span.span_id);
      const latency =
        typeof usage?.latency_s === "number"
          ? usage.latency_s
          : isMarker(span)
            ? undefined
            : (span.end_ms - span.start_ms) / 1000;
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
    } else if (span.name === "fusion.judge.request") {
      const messages = attrJson<unknown>(span, "fusion.messages");
      if (prompt === undefined) prompt = firstUserMessage(messages);
      judge.prompt = {
        judgeModel: attrStr(span, "fusion.judge.model"),
        messages,
        trajectories: attrJson<unknown>(span, "fusion.trajectories"),
        tools: attrJson<unknown>(span, "fusion.tools"),
        trajectoryIds: attrStrArray(span, "fusion.trajectory_ids")
      };
      const step = ensureStep(enclosingJudgeSpan(span), span.end_ms);
      step.prompt = judge.prompt;
      step.turn = attrNum(span, "fusion.turn") ?? step.turn;
    } else if (span.name === "fusion.judge.thinking") {
      const raw = attrStr(span, "fusion.raw_analysis");
      judge.thinking = {
        fusionUnit: attrStr(span, "fusion.fusion_unit"),
        raw,
        usage: usageOf(span)
      };
      const step = ensureStep(enclosingJudgeSpan(span), span.end_ms);
      if (step.kind === "pending") step.kind = "intermediate";
      step.turn = attrNum(span, "fusion.turn") ?? step.turn;
      step.thinking = {
        raw,
        toolCalls: attrJson<unknown>(span, "fusion.tool_calls"),
        usage: usageOf(span)
      };
    } else if (span.name === "fusion.judge.scored") {
      judge.scored = {
        fusionUnit: attrStr(span, "fusion.fusion_unit"),
        analysis: attrJson<Record<string, unknown>>(span, "fusion.analysis"),
        metrics: attrJson<Record<string, unknown>>(span, "fusion.metrics"),
        inputIds: attrStrArray(span, "fusion.input_ids")
      };
    } else if (span.name === "fusion.judge.synthesis") {
      judge.synthesis = {
        raw: attrStr(span, "fusion.raw_output"),
        empty: attrBool(span, "fusion.synthesis_empty") === true,
        usage: usageOf(span)
      };
    } else if (span.name === "fusion.judge") {
      sawGatewayJudge = true;
      applyJudgeFinal(span);
    } else if (span.name === "fusion.fuse") {
      // Server-side fuse execution: only authoritative when no gateway judge
      // span covers this session (e.g. the fuse endpoint driven directly).
      if (!sawGatewayJudge && attrBool(span, "fusion.terminal") === true) {
        applyJudgeFinal(span);
      }
    } else if (span.name === "fusion.narration") {
      const headline = attrStr(span, "fusion.headline");
      if (headline !== undefined) {
        narration.push({
          ts: span.end_ms,
          headline,
          ...(attrNum(span, "fusion.turn") !== undefined ? { turn: attrNum(span, "fusion.turn") } : {}),
          ...(attrStr(span, "fusion.prose") !== undefined ? { prose: attrStr(span, "fusion.prose") } : {})
        });
      }
    } else if (span.name === "fusion.cost") {
      costUsd = (costUsd ?? 0) + (attrNum(span, "fusion.cost.turn_usd") ?? 0);
      if (attrBool(span, "fusion.cost.unknown") === true) costIncomplete = true;
    }
  }

  for (const candidate of candidates.values()) {
    candidate.steps.sort((a, b) => a.index - b.index);
  }

  const startedAt = sorted.length > 0 ? sorted[0].start_ms : 0;
  const lastTs = sorted.reduce((max, span) => Math.max(max, span.end_ms), startedAt);

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
    spans: sorted
  };
}
