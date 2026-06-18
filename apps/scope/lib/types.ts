// Mirror of the standalone fusion-trace-event.v1 contract
// (fusionkit spec/fusion-trace/schema/fusion-trace-event.v1.schema.json).

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

export const TRACE_COMPONENTS: FusionTraceComponent[] = [
  "gateway",
  "ensemble",
  "agent",
  "panel-model",
  "judge",
  "synthesis",
  "cursor-bridge"
];

export const TRACE_EVENT_TYPES: FusionTraceEventType[] = [
  "session.started",
  "session.finished",
  "harness.candidate.started",
  "harness.candidate.finished",
  "trajectory.step",
  "model.call.started",
  "model.call.finished",
  "judge.thinking",
  "judge.scored",
  "judge.synthesis",
  "judge.final",
  "tool.execution",
  "cursor.route",
  "log"
];

export type FusionTraceEvent = {
  schema: "fusion-trace-event.v1";
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

/** A stored event row (with the collector's monotonic ingest id). */
export type StoredEvent = FusionTraceEvent & { id: number };

/** Raw environment snapshot as carried in a session.started payload (snake_case). */
export type RawEnvironment = {
  repo?: string;
  fusion_backend_url?: string;
  synthesis_url?: string;
  gateway_url?: string;
  harnesses?: string[];
  harness?: string;
  judge_model?: string | null;
  models?: Array<{ id: string; model: string; endpoint_id?: string; provider?: string }>;
  model_endpoints?: Record<string, string>;
};

export function isFusionTraceEvent(value: unknown): value is FusionTraceEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.schema === "fusion-trace-event.v1" &&
    typeof event.trace_id === "string" &&
    typeof event.span_id === "string" &&
    typeof event.seq === "number" &&
    typeof event.ts === "number" &&
    typeof event.component === "string" &&
    typeof event.event_type === "string" &&
    TRACE_COMPONENTS.includes(event.component as FusionTraceComponent) &&
    TRACE_EVENT_TYPES.includes(event.event_type as FusionTraceEventType)
  );
}
