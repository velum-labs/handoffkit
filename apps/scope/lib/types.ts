import { FUSION_SCOPES } from "./generated/trace-conventions";

/**
 * The collector's native units: finished OTel spans (units of work with real
 * durations, from the traces signal) and fusion events (live point-in-time
 * signals, from the logs signal). Span, event, and attribute names follow the
 * fusion semantic conventions in spec/fusion-trace/registry.json.
 */
export type StoredSpan = {
  /** Monotonic ingest id (collector-local). */
  id: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  /** Span name per the fusion conventions (e.g. "fusion.candidate", "chat gpt-5.5"). */
  name: string;
  /** Fusion component, derived from the instrumentation scope (e.g. "judge"). */
  component: string;
  /** OTel resource service.name of the emitting process. */
  service?: string;
  start_ms: number;
  end_ms: number;
  status: "unset" | "ok" | "error";
  status_message?: string;
  attributes: Record<string, unknown>;
};

/** A span as parsed from an OTLP payload, before the collector assigns an id. */
export type IncomingSpan = Omit<StoredSpan, "id">;

/**
 * One fusion event: a point-in-time signal carried as an OTel log record with
 * `event_name` plus trace/span correlation (the owning unit span).
 */
export type StoredEvent = {
  /** Monotonic ingest id (collector-local). */
  id: number;
  trace_id: string;
  /** The owning unit span, when the emitter had an active span context. */
  span_id?: string;
  /** Event name per the fusion conventions (e.g. "fusion.candidate.step"). */
  name: string;
  /** Fusion component, derived from the instrumentation scope (e.g. "judge"). */
  component: string;
  /** OTel resource service.name of the emitting process. */
  service?: string;
  ts_ms: number;
  attributes: Record<string, unknown>;
};

/** An event as parsed from an OTLP logs payload, before the collector assigns an id. */
export type IncomingEvent = Omit<StoredEvent, "id">;

/** Any stored signal (span or event) that carries attributes. */
export type AttributeSource = { attributes: Record<string, unknown> };

/** A stored signal with its kind, as passed between dashboard components. */
export type StoredSignal = ({ kind: "span" } & StoredSpan) | ({ kind: "event" } & StoredEvent);

/** A stable, URL-safe identity for one stored signal. */
export function signalKey(signal: StoredSignal): string {
  return signal.kind === "span" ? signal.span_id : `event-${signal.id}`;
}

/** Component names, for legends and color coding. */
export const TRACE_COMPONENTS: string[] = Object.keys(FUSION_SCOPES);

const SCOPE_TO_COMPONENT = new Map<string, string>(
  Object.entries(FUSION_SCOPES).map(([component, scope]) => [scope, component])
);

/** Map an instrumentation scope name back to its fusion component. */
export function componentOfScope(scope: string | undefined): string {
  if (scope === undefined) return "gateway";
  return SCOPE_TO_COMPONENT.get(scope) ?? scope.replace(/^fusionkit\./, "");
}

export function attrStr(source: AttributeSource, key: string): string | undefined {
  const value = source.attributes[key];
  return typeof value === "string" ? value : undefined;
}

export function attrNum(source: AttributeSource, key: string): number | undefined {
  const value = source.attributes[key];
  return typeof value === "number" ? value : undefined;
}

export function attrBool(source: AttributeSource, key: string): boolean | undefined {
  const value = source.attributes[key];
  return typeof value === "boolean" ? value : undefined;
}

export function attrStrArray(source: AttributeSource, key: string): string[] | undefined {
  const value = source.attributes[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/** Parse a JSON-string attribute (structured values ride as JSON strings). */
export function attrJson<T>(source: AttributeSource, key: string): T | undefined {
  const raw = attrStr(source, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Candidate/model correlation attributes shared by panel spans and events. */
export function candidateIdOf(source: AttributeSource): string | undefined {
  return attrStr(source, "fusion.candidate.id");
}

export function modelIdOf(source: AttributeSource): string | undefined {
  return attrStr(source, "fusion.model.id") ?? attrStr(source, "gen_ai.request.model");
}

/** Raw environment snapshot as carried in a fusion.environment attribute (snake_case). */
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
