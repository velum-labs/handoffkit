/**
 * fusion-trace-event.v1 — fire-and-forget observability emitter.
 *
 * This is the canonical TypeScript implementation of the standalone fusion-trace
 * contract (see fusionkit `spec/fusion-trace`). It lives in `@fusionkit/protocol`
 * (a dependency-free leaf) so the gateway, ensemble harness, the AI SDK worktree
 * agent, and the CLI can all emit against the same shape without import cycles.
 *
 * Emission is a no-op unless `FUSION_TRACE_URL` or `FUSION_TRACE_DIR` is set, so
 * normal runs are never blocked by, or coupled to, the collector.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const FUSION_TRACE_EVENT_SCHEMA = "fusion-trace-event.v1" as const;
export const FUSION_TRACE_EVENT_VERSION = "1.0.0" as const;

export const TRACE_ID_HEADER = "x-fusion-trace-id";
export const TRACE_SPAN_HEADER = "x-fusion-span-id";
export const TRACE_PARENT_SPAN_HEADER = "x-fusion-parent-span-id";
export const TRACE_CANDIDATE_HEADER = "x-fusion-candidate-id";

export type FusionTraceComponent =
  | "gateway"
  | "ensemble"
  | "agent"
  | "panel-model"
  | "judge"
  | "synthesis"
  | "cursor-bridge";

export type FusionTraceEventType =
  | "session.started"
  | "session.finished"
  | "harness.candidate.started"
  | "harness.candidate.finished"
  | "trajectory.step"
  | "model.call.started"
  | "model.call.finished"
  | "judge.request"
  | "judge.thinking"
  | "judge.scored"
  | "judge.synthesis"
  | "judge.final"
  | "tool.execution"
  | "cursor.route"
  | "log";

/** Runtime-iterable mirrors of the closed unions (used by the validator). */
export const FUSION_TRACE_COMPONENTS: readonly FusionTraceComponent[] = [
  "gateway",
  "ensemble",
  "agent",
  "panel-model",
  "judge",
  "synthesis",
  "cursor-bridge"
];

export const FUSION_TRACE_EVENT_TYPES: readonly FusionTraceEventType[] = [
  "session.started",
  "session.finished",
  "harness.candidate.started",
  "harness.candidate.finished",
  "trajectory.step",
  "model.call.started",
  "model.call.finished",
  "judge.request",
  "judge.thinking",
  "judge.scored",
  "judge.synthesis",
  "judge.final",
  "tool.execution",
  "cursor.route",
  "log"
];

export type FusionTraceEvent = {
  schema: typeof FUSION_TRACE_EVENT_SCHEMA;
  schema_version?: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  seq: number;
  ts: number;
  component: FusionTraceComponent;
  event_type: FusionTraceEventType;
  session_id?: string;
  candidate_id?: string;
  model_id?: string;
  payload?: Record<string, unknown>;
};

export type EmitInput = {
  component: FusionTraceComponent;
  event_type: FusionTraceEventType;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  candidateId?: string;
  modelId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
};

export function newTraceId(): string {
  return `trace_${randomUUID().replace(/-/g, "")}`;
}

export function newSpanId(): string {
  return `span_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function ambientTraceId(): string | undefined {
  const value = process.env.FUSION_TRACE_ID;
  return value && value.length > 0 ? value : undefined;
}

export class TraceEmitter {
  private readonly url?: string;
  private readonly dir?: string;
  private readonly enabled: boolean;
  private seq = 0;
  private dirReady = false;

  constructor(config?: { url?: string; dir?: string }) {
    this.url = config?.url ?? process.env.FUSION_TRACE_URL ?? undefined;
    this.dir = config?.dir ?? process.env.FUSION_TRACE_DIR ?? undefined;
    this.enabled = Boolean(this.url || this.dir);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  emit(input: EmitInput): void {
    if (!this.enabled) return;
    const traceId = input.traceId ?? ambientTraceId();
    if (traceId === undefined) return;
    const event: FusionTraceEvent = {
      schema: FUSION_TRACE_EVENT_SCHEMA,
      schema_version: FUSION_TRACE_EVENT_VERSION,
      trace_id: traceId,
      span_id: input.spanId ?? newSpanId(),
      seq: this.seq++,
      ts: Date.now(),
      component: input.component,
      event_type: input.event_type,
      ...(input.parentSpanId !== undefined ? { parent_span_id: input.parentSpanId } : {}),
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      ...(input.candidateId !== undefined ? { candidate_id: input.candidateId } : {}),
      ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {})
    };
    this.writeJsonl(event);
    void this.post(event);
  }

  private writeJsonl(event: FusionTraceEvent): void {
    if (this.dir === undefined) return;
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(join(this.dir, `${event.trace_id}.jsonl`), `${JSON.stringify(event)}\n`);
    } catch {
      // best-effort durable fallback
    }
  }

  private async post(event: FusionTraceEvent): Promise<void> {
    if (this.url === undefined) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [event] }),
        signal: controller.signal
      }).catch(() => undefined);
      clearTimeout(timeout);
    } catch {
      // collector being down must never break a run
    }
  }
}

let defaultEmitter: TraceEmitter | undefined;

export function getTraceEmitter(): TraceEmitter {
  if (defaultEmitter === undefined) defaultEmitter = new TraceEmitter();
  return defaultEmitter;
}

export function emitTrace(input: EmitInput): void {
  getTraceEmitter().emit(input);
}

// ---- runtime validation (the formalized fusion-trace-event.v1 contract) ----

function fail(message: string): never {
  throw new Error(`invalid fusion-trace-event.v1: ${message}`);
}

/**
 * Assert that `value` is a well-formed wire `FusionTraceEvent`. Hand-written
 * (Node-only, no deps) to match the `assertModelFusionRecord` style, so both the
 * emitter side and the scope ingest boundary validate against one contract.
 */
export function assertFusionTraceEvent(value: unknown): asserts value is FusionTraceEvent {
  if (typeof value !== "object" || value === null) fail("event must be an object");
  const event = value as Record<string, unknown>;
  if (event.schema !== FUSION_TRACE_EVENT_SCHEMA) fail(`schema must be "${FUSION_TRACE_EVENT_SCHEMA}"`);
  if (typeof event.trace_id !== "string" || event.trace_id.length === 0) fail("trace_id must be a non-empty string");
  if (typeof event.span_id !== "string" || event.span_id.length === 0) fail("span_id must be a non-empty string");
  if (typeof event.seq !== "number" || !Number.isFinite(event.seq)) fail("seq must be a finite number");
  if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) fail("ts must be a finite number");
  if (!FUSION_TRACE_COMPONENTS.includes(event.component as FusionTraceComponent)) {
    fail(`unknown component "${String(event.component)}"`);
  }
  if (!FUSION_TRACE_EVENT_TYPES.includes(event.event_type as FusionTraceEventType)) {
    fail(`unknown event_type "${String(event.event_type)}"`);
  }
  if (event.parent_span_id !== undefined && typeof event.parent_span_id !== "string") {
    fail("parent_span_id must be a string when present");
  }
  for (const key of ["session_id", "candidate_id", "model_id"] as const) {
    if (event[key] !== undefined && typeof event[key] !== "string") fail(`${key} must be a string when present`);
  }
  if (
    event.payload !== undefined &&
    (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload))
  ) {
    fail("payload must be a plain object when present");
  }
}

export function isFusionTraceEvent(value: unknown): value is FusionTraceEvent {
  try {
    assertFusionTraceEvent(value);
    return true;
  } catch {
    return false;
  }
}

// ---- typed per-event payload builders (snake_case wire shape) ----
//
// One builder per emitted event keeps payload field names consistent across
// every emit site and documents exactly what each event carries. The scope
// collector reads these field names directly.

export function judgeRequestPayload(input: {
  judgeModel?: string;
  messages: unknown;
  trajectories: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  trajectoryIds?: string[];
  /** 1-based user-turn index (a follow-up message is a new turn). */
  turn?: number;
}): Record<string, unknown> {
  return {
    ...(input.judgeModel !== undefined ? { judge_model: input.judgeModel } : {}),
    messages: input.messages,
    trajectories: input.trajectories,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
    ...(input.trajectoryIds !== undefined ? { trajectory_ids: input.trajectoryIds } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {})
  };
}

/** An intermediate (tool-calling) judge step within a turn. */
export function judgeThinkingPayload(input: {
  rawAnalysis?: string;
  toolCalls?: unknown;
  usage?: unknown;
  turn?: number;
}): Record<string, unknown> {
  return {
    ...(input.rawAnalysis !== undefined ? { raw_analysis: input.rawAnalysis } : {}),
    ...(input.toolCalls !== undefined ? { tool_calls: input.toolCalls } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {})
  };
}

export function judgeFinalPayload(input: {
  finalOutput?: string;
  content?: string;
  toolCalls?: unknown;
  usage?: unknown;
  httpStatus?: number;
  error?: string;
  turn?: number;
}): Record<string, unknown> {
  const finalOutput = input.finalOutput ?? input.content;
  return {
    ...(finalOutput !== undefined ? { final_output: finalOutput, record: { final_output: finalOutput } } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.toolCalls !== undefined ? { tool_calls: input.toolCalls } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.httpStatus !== undefined ? { http_status: input.httpStatus } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {})
  };
}

export function modelCallStartedPayload(input: {
  model: string;
  systemPrompt?: string;
  prompt?: string;
  tools?: string[];
  turn?: number;
}): Record<string, unknown> {
  return {
    model: input.model,
    ...(input.systemPrompt !== undefined ? { system_prompt: input.systemPrompt } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {})
  };
}

export function modelCallFinishedPayload(input: {
  model: string;
  finalOutput?: string;
  usage?: unknown;
  finishReason?: string;
  stepCount?: number;
  toolCallCount?: number;
  latencyS?: number;
  error?: string;
  turn?: number;
}): Record<string, unknown> {
  return {
    model: input.model,
    ...(input.finalOutput !== undefined
      ? { final_output: input.finalOutput, content_preview: input.finalOutput.slice(0, 280) }
      : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.finishReason !== undefined ? { finish_reason: input.finishReason } : {}),
    ...(input.stepCount !== undefined ? { step_count: input.stepCount } : {}),
    ...(input.toolCallCount !== undefined ? { tool_call_count: input.toolCallCount } : {}),
    ...(input.latencyS !== undefined ? { latency_s: input.latencyS } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {})
  };
}
