import type { StoredEvent } from "./types";

/**
 * Pure aggregation: fold a session's flat event list into the structured view
 * the dashboard renders (environment, per-candidate trajectories, the judge's
 * thinking-to-final flow, and paired panel-model calls). Kept dependency-free
 * so it can be unit tested directly.
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
  /** Full system prompt the panel model ran under (from model.call.started). */
  systemPrompt?: string;
  /** Full task prompt sent to the panel model (from model.call.started). */
  prompt?: string;
  /** Full final output of the panel model (from model.call.finished). */
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
};

export type JudgeView = {
  /** The full prompt sent to the judge (the trajectory:step request). */
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
    synthesisId?: string;
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
 * One judge step = one gateway call (one `judge` span): the prompt sent plus its
 * outcome (an intermediate tool-calling turn or the terminal answer). Multiple
 * steps share a `turn` when they belong to the same user message (the harness's
 * internal tool loop); a follow-up user message is a new `turn`.
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
  models?: Array<{ id: string; model: string; endpoint_id?: string }>;
  modelEndpoints?: Record<string, string>;
};

export type SessionDetail = {
  traceId: string;
  status: string;
  startedAt: number;
  lastTs: number;
  dialect?: string;
  promptPreview?: string;
  environment?: EnvironmentView;
  candidates: CandidateView[];
  modelCalls: ModelCallView[];
  judge: JudgeView;
  /** Per-step judge history (ordered), so multi-turn sessions don't collapse. */
  judgeSteps: JudgeStepView[];
  finalOutput?: string;
  evidence?: string[];
  durationMs: number;
  eventCounts: Record<string, number>;
  events: StoredEvent[];
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function deriveSession(traceId: string, events: StoredEvent[]): SessionDetail {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const candidates = new Map<string, CandidateView>();
  const modelCalls = new Map<string, ModelCallView>();
  const judge: JudgeView = {};
  const judgeStepMap = new Map<string, JudgeStepView>();
  const eventCounts: Record<string, number> = {};

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
  let environment: EnvironmentView | undefined;
  let finalOutput: string | undefined;
  let evidence: string[] | undefined;

  const ensureCandidate = (id: string): CandidateView => {
    let candidate = candidates.get(id);
    if (candidate === undefined) {
      candidate = { candidateId: id, steps: [] };
      candidates.set(id, candidate);
    }
    return candidate;
  };

  for (const event of sorted) {
    eventCounts[event.event_type] = (eventCounts[event.event_type] ?? 0) + 1;
    const payload = obj(event.payload);

    switch (event.event_type) {
      case "session.started": {
        dialect = str(payload.dialect) ?? dialect;
        promptPreview = str(payload.prompt_preview) ?? promptPreview;
        const env = obj(payload.environment);
        environment = {
          repo: str(env.repo),
          fusionBackendUrl: str(env.fusion_backend_url),
          harnesses: Array.isArray(env.harnesses) ? (env.harnesses as string[]) : undefined,
          judgeModel: (env.judge_model as string | null | undefined) ?? undefined,
          models: Array.isArray(env.models)
            ? (env.models as Array<{ id: string; model: string; endpoint_id?: string }>)
            : undefined,
          modelEndpoints: typeof env.model_endpoints === "object" && env.model_endpoints !== null
            ? (env.model_endpoints as Record<string, string>)
            : undefined
        };
        break;
      }
      case "session.finished": {
        status = str(payload.status) ?? status;
        finalOutput = str(payload.final_output_preview) ?? finalOutput;
        if (Array.isArray(payload.evidence)) evidence = payload.evidence as string[];
        break;
      }
      case "harness.candidate.started": {
        if (event.candidate_id !== undefined) {
          const candidate = ensureCandidate(event.candidate_id);
          candidate.modelId = event.model_id ?? candidate.modelId;
          candidate.model = str(payload.model) ?? candidate.model;
          candidate.turn = num(payload.turn) ?? candidate.turn;
          candidate.branchName = str(payload.branch_name) ?? candidate.branchName;
          candidate.worktreePath = str(payload.worktree_path) ?? candidate.worktreePath;
        }
        break;
      }
      case "harness.candidate.finished": {
        if (event.candidate_id !== undefined) {
          const candidate = ensureCandidate(event.candidate_id);
          candidate.status = str(payload.status) ?? candidate.status;
          candidate.turn = num(payload.turn) ?? candidate.turn;
          candidate.toolCallCount = num(payload.tool_call_count) ?? candidate.toolCallCount;
          candidate.finishReason = str(payload.finish_reason) ?? candidate.finishReason;
          candidate.verificationStatus = str(payload.verification_status) ?? candidate.verificationStatus;
          candidate.finalOutputPreview = str(payload.final_output_preview) ?? candidate.finalOutputPreview;
        }
        break;
      }
      case "trajectory.step": {
        if (event.candidate_id !== undefined) {
          const candidate = ensureCandidate(event.candidate_id);
          candidate.modelId = candidate.modelId ?? event.model_id;
          const step = obj(payload.step) as unknown as TrajectoryStepView;
          if (typeof step.index === "number" && typeof step.type === "string") {
            candidate.steps.push(step);
          }
        }
        break;
      }
      case "model.call.started": {
        modelCalls.set(event.span_id, {
          spanId: event.span_id,
          modelId: event.model_id,
          candidateId: event.candidate_id,
          provider: str(payload.provider),
          model: str(payload.model),
          status: "running",
          ts: event.ts
        });
        if (event.candidate_id !== undefined) {
          const candidate = ensureCandidate(event.candidate_id);
          candidate.systemPrompt = str(payload.system_prompt) ?? candidate.systemPrompt;
          candidate.prompt = str(payload.prompt) ?? candidate.prompt;
        }
        break;
      }
      case "model.call.finished": {
        const existing = modelCalls.get(event.span_id) ?? {
          spanId: event.span_id,
          modelId: event.model_id,
          candidateId: event.candidate_id,
          status: "running" as const,
          ts: event.ts
        };
        modelCalls.set(event.span_id, {
          ...existing,
          provider: str(payload.provider) ?? existing.provider,
          model: str(payload.model) ?? existing.model,
          status: payload.error !== undefined ? "failed" : "succeeded",
          latencyS: num(payload.latency_s) ?? existing.latencyS,
          finishReason: str(payload.finish_reason) ?? existing.finishReason,
          usage: typeof payload.usage === "object" && payload.usage !== null
            ? (payload.usage as Record<string, unknown>)
            : existing.usage,
          contentPreview: str(payload.content_preview) ?? existing.contentPreview,
          error: str(payload.error) ?? existing.error
        });
        if (event.candidate_id !== undefined) {
          const candidate = ensureCandidate(event.candidate_id);
          candidate.finalOutput = str(payload.final_output) ?? candidate.finalOutput;
          if (typeof payload.usage === "object" && payload.usage !== null) {
            candidate.usage = payload.usage as Record<string, unknown>;
          }
        }
        break;
      }
      case "judge.request": {
        judge.prompt = {
          judgeModel: str(payload.judge_model),
          messages: payload.messages,
          trajectories: payload.trajectories,
          tools: payload.tools,
          trajectoryIds: Array.isArray(payload.trajectory_ids)
            ? (payload.trajectory_ids as string[])
            : undefined
        };
        const step = ensureStep(event.span_id, event.ts);
        step.prompt = judge.prompt;
        step.turn = num(payload.turn) ?? step.turn;
        break;
      }
      case "judge.thinking": {
        judge.thinking = {
          fusionUnit: str(payload.fusion_unit),
          raw: str(payload.raw_analysis),
          usage: typeof payload.usage === "object" && payload.usage !== null ? (payload.usage as Record<string, unknown>) : undefined
        };
        const step = ensureStep(event.span_id, event.ts);
        step.kind = "intermediate";
        step.turn = num(payload.turn) ?? step.turn;
        step.thinking = {
          raw: str(payload.raw_analysis),
          toolCalls: payload.tool_calls,
          usage:
            typeof payload.usage === "object" && payload.usage !== null
              ? (payload.usage as Record<string, unknown>)
              : undefined
        };
        break;
      }
      case "judge.scored": {
        judge.scored = {
          fusionUnit: str(payload.fusion_unit),
          analysis: obj(payload.analysis),
          metrics: obj(payload.metrics),
          inputIds: Array.isArray(payload.input_ids) ? (payload.input_ids as string[]) : undefined
        };
        break;
      }
      case "judge.synthesis": {
        judge.synthesis = {
          raw: str(payload.raw_output),
          empty: payload.empty === true,
          usage: typeof payload.usage === "object" && payload.usage !== null ? (payload.usage as Record<string, unknown>) : undefined
        };
        break;
      }
      case "judge.final": {
        judge.final = {
          synthesisId: str(payload.synthesis_id),
          decision: str(payload.decision),
          rationale: str(payload.rationale),
          finalOutput: str(payload.final_output),
          content: str(payload.content),
          usage: typeof payload.usage === "object" && payload.usage !== null
            ? (payload.usage as Record<string, unknown>)
            : undefined,
          selectedCandidateId: str(payload.selected_trajectory_id),
          record: obj(payload.record)
        };
        const judgeFinal = judge.final.finalOutput ?? judge.final.content;
        if (judgeFinal !== undefined) finalOutput = judgeFinal;
        const step = ensureStep(event.span_id, event.ts);
        step.kind = "final";
        step.turn = num(payload.turn) ?? step.turn;
        step.final = {
          finalOutput: str(payload.final_output),
          content: str(payload.content),
          decision: str(payload.decision),
          rationale: str(payload.rationale),
          selectedCandidateId: str(payload.selected_trajectory_id),
          usage:
            typeof payload.usage === "object" && payload.usage !== null
              ? (payload.usage as Record<string, unknown>)
              : undefined
        };
        break;
      }
      default:
        break;
    }
  }

  for (const candidate of candidates.values()) {
    candidate.steps.sort((a, b) => a.index - b.index);
  }

  const startedAt = sorted.length > 0 ? sorted[0].ts : 0;
  const lastTs = sorted.length > 0 ? sorted[sorted.length - 1].ts : startedAt;

  return {
    traceId,
    status,
    startedAt,
    lastTs,
    ...(dialect !== undefined ? { dialect } : {}),
    ...(promptPreview !== undefined ? { promptPreview } : {}),
    ...(environment !== undefined ? { environment } : {}),
    candidates: [...candidates.values()],
    modelCalls: [...modelCalls.values()].sort((a, b) => a.ts - b.ts),
    judge,
    judgeSteps: [...judgeStepMap.values()].sort((a, b) => a.ts - b.ts),
    ...(finalOutput !== undefined ? { finalOutput } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    durationMs: Math.max(0, lastTs - startedAt),
    eventCounts,
    events: sorted
  };
}
