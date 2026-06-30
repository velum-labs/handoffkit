// Canonical TypeScript binding for fusion-trace-event.v1.
// This contract is standalone and NOT part of the frozen model-fusion-contract bundle.
// Consumers (scopekit, handoffkit, cursorkit) may embed a copy of these types alongside
// their emitter; keep them in sync with schema/fusion-trace-event.v1.schema.json.

export const FUSION_TRACE_EVENT_SCHEMA = "fusion-trace-event.v1" as const;
export const FUSION_TRACE_EVENT_VERSION = "1.0.0" as const;

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
  trajectory_id?: string;
  model_id?: string;
  payload?: Record<string, unknown>;
};

// HTTP headers used to propagate trace context across process/wire boundaries.
export const TRACE_ID_HEADER = "x-fusion-trace-id";
export const TRACE_SPAN_HEADER = "x-fusion-span-id";
export const TRACE_PARENT_SPAN_HEADER = "x-fusion-parent-span-id";
export const TRACE_TRAJECTORY_HEADER = "x-fusion-trajectory-id";
