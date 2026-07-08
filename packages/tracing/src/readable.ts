/**
 * Accessors for finished spans and emitted fusion events as seen by
 * in-process listeners (the narrator, product telemetry). Keeps attribute
 * reads typed and tolerant across both signal shapes.
 */
import type { HrTime, SpanContext } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type { ReadableSpan };

/**
 * A fusion event as seen by consumers: the read-only face of an emitted log
 * record. Both the SDK's in-process `SdkLogRecord` (listeners) and exported
 * `ReadableLogRecord` (test exporters) satisfy this shape.
 */
export type ReadableFusionEvent = {
  readonly hrTime: HrTime;
  readonly spanContext?: SpanContext;
  readonly eventName?: string;
  readonly attributes: Record<string, unknown>;
  readonly instrumentationScope: { readonly name: string };
};

/** Anything carrying an attribute bag: a span or an event record. */
export type AttributeSource = { attributes: Record<string, unknown> };

export function spanTraceId(span: ReadableSpan): string {
  return span.spanContext().traceId;
}

export function spanId(span: ReadableSpan): string {
  return span.spanContext().spanId;
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

export function attrJson<T>(source: AttributeSource, key: string): T | undefined {
  const raw = attrStr(source, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Wall-clock end of the span in epoch milliseconds. */
export function spanEndMs(span: ReadableSpan): number {
  const [seconds, nanos] = span.endTime;
  return seconds * 1000 + nanos / 1e6;
}

/** The event's name (`event_name` on the log record). */
export function eventNameOf(event: ReadableFusionEvent): string {
  return event.eventName ?? "";
}

/** Trace id of the event's owning trace, when correlated. */
export function eventTraceId(event: ReadableFusionEvent): string | undefined {
  return event.spanContext?.traceId;
}

/** Span id of the event's owning span, when correlated. */
export function eventSpanId(event: ReadableFusionEvent): string | undefined {
  return event.spanContext?.spanId;
}

/** Wall-clock timestamp of the event in epoch milliseconds. */
export function eventTimeMs(event: ReadableFusionEvent): number {
  const [seconds, nanos] = event.hrTime;
  return seconds * 1000 + nanos / 1e6;
}
