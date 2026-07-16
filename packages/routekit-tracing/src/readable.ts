import type { HrTime, SpanContext } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export type { ReadableSpan };
export type ReadableEvent = {
  readonly hrTime: HrTime;
  readonly spanContext?: SpanContext;
  readonly eventName?: string;
  readonly attributes: Record<string, unknown>;
  readonly instrumentationScope: { readonly name: string };
};
export type AttributeSource = { attributes: Record<string, unknown> };

export const spanTraceId = (span: ReadableSpan): string => span.spanContext().traceId;
export const spanId = (span: ReadableSpan): string => span.spanContext().spanId;
export const attrStr = (source: AttributeSource, key: string): string | undefined =>
  typeof source.attributes[key] === "string" ? (source.attributes[key] as string) : undefined;
export const attrNum = (source: AttributeSource, key: string): number | undefined =>
  typeof source.attributes[key] === "number" ? (source.attributes[key] as number) : undefined;
export const attrBool = (source: AttributeSource, key: string): boolean | undefined =>
  typeof source.attributes[key] === "boolean" ? (source.attributes[key] as boolean) : undefined;

export function attrJson<T>(source: AttributeSource, key: string): T | undefined {
  const raw = attrStr(source, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function spanEndMs(span: ReadableSpan): number {
  return span.endTime[0] * 1000 + span.endTime[1] / 1e6;
}

export const eventNameOf = (event: ReadableEvent): string => event.eventName ?? "";
export const eventTraceId = (event: ReadableEvent): string | undefined =>
  event.spanContext?.traceId;
export const eventSpanId = (event: ReadableEvent): string | undefined =>
  event.spanContext?.spanId;
export const eventTimeMs = (event: ReadableEvent): number =>
  event.hrTime[0] * 1000 + event.hrTime[1] / 1e6;
