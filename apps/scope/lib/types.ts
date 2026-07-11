import { FUSION_SCOPES } from "./generated/trace-conventions";

/**
 * The collector's native unit: one finished OTel span, as flattened from an
 * OTLP export. Markers (live point-in-time signals) are zero-duration spans;
 * units of work (turn, candidate, judge, model call) carry real durations and
 * terminal attributes. Span and attribute names follow the fusion semantic
 * conventions in spec/fusion-trace/registry.json.
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

/** True when the span is an instant marker (a live point-in-time signal). */
export function isMarker(span: Pick<StoredSpan, "start_ms" | "end_ms">): boolean {
  return span.end_ms - span.start_ms <= 0;
}

export function attrStr(span: StoredSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

export function attrNum(span: StoredSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

export function attrBool(span: StoredSpan, key: string): boolean | undefined {
  const value = span.attributes[key];
  return typeof value === "boolean" ? value : undefined;
}

export function attrStrArray(span: StoredSpan, key: string): string[] | undefined {
  const value = span.attributes[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/** Parse a JSON-string attribute (structured values ride as JSON strings). */
export function attrJson<T>(span: StoredSpan, key: string): T | undefined {
  const raw = attrStr(span, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Candidate/model correlation attributes shared by panel spans. */
export function candidateIdOf(span: StoredSpan): string | undefined {
  return attrStr(span, "fusion.candidate.id");
}

export function modelIdOf(span: StoredSpan): string | undefined {
  return attrStr(span, "fusion.model.id") ?? attrStr(span, "gen_ai.request.model");
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
