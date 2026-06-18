/**
 * fusion-trace-event.v1 — fire-and-forget observability emitter.
 *
 * This is the canonical TypeScript implementation of the standalone fusion-trace
 * contract (see fusionkit `spec/fusion-trace`). It lives in `@warrant/protocol`
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
  | "judge.thinking"
  | "judge.scored"
  | "judge.synthesis"
  | "judge.final"
  | "tool.execution"
  | "cursor.route"
  | "log";

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
