/**
 * Accessors for finished spans as seen by in-process listeners (the
 * narrator, product telemetry). Keeps attribute reads typed and tolerant.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type { ReadableSpan };

export function spanTraceId(span: ReadableSpan): string {
  return span.spanContext().traceId;
}

export function spanId(span: ReadableSpan): string {
  return span.spanContext().spanId;
}

export function attrStr(span: ReadableSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

export function attrNum(span: ReadableSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

export function attrBool(span: ReadableSpan, key: string): boolean | undefined {
  const value = span.attributes[key];
  return typeof value === "boolean" ? value : undefined;
}

export function attrJson<T>(span: ReadableSpan, key: string): T | undefined {
  const raw = attrStr(span, key);
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
