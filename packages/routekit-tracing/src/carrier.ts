import { randomBytes } from "node:crypto";

import { context as apiContext, propagation } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";

export type TraceCarrier = { traceparent: string; baggage?: string };

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function sessionCarrier(traceId: string, spanId: string): TraceCarrier {
  return { traceparent: `00-${traceId}-${spanId}-01` };
}

export function newSessionCarrier(): { traceId: string; carrier: TraceCarrier } {
  const traceId = newTraceId();
  return { traceId, carrier: sessionCarrier(traceId, newSpanId()) };
}

export function contextOf(carrier: TraceCarrier | undefined): Context {
  if (carrier === undefined) return apiContext.active();
  return propagation.extract(apiContext.active(), carrier, {
    get: (value, key) => (value as Record<string, string | undefined>)[key],
    keys: (value) => Object.keys(value as Record<string, string>)
  });
}

export function carrierOf(context: Context): TraceCarrier {
  const target: Record<string, string> = {};
  propagation.inject(context, target, {
    set: (value, key, content) => {
      value[key] = content;
    }
  });
  if (target.traceparent === undefined) return newSessionCarrier().carrier;
  return {
    traceparent: target.traceparent,
    ...(target.baggage !== undefined ? { baggage: target.baggage } : {})
  };
}

export function traceIdOf(carrier: TraceCarrier): string {
  return carrier.traceparent.split("-")[1] ?? "";
}

export function carrierFromHeaders(
  headers: Record<string, string | string[] | undefined>
): TraceCarrier | undefined {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const traceparent = first(headers.traceparent);
  if (traceparent === undefined || traceparent.length === 0) return undefined;
  const baggage = first(headers.baggage);
  return { traceparent, ...(baggage !== undefined && baggage.length > 0 ? { baggage } : {}) };
}

export function headersOf(carrier: TraceCarrier): Record<string, string> {
  return {
    traceparent: carrier.traceparent,
    ...(carrier.baggage !== undefined ? { baggage: carrier.baggage } : {})
  };
}

export function envOf(carrier: TraceCarrier): Record<string, string> {
  return {
    TRACEPARENT: carrier.traceparent,
    ...(carrier.baggage !== undefined ? { BAGGAGE: carrier.baggage } : {})
  };
}

export function carrierFromEnv(
  env: Record<string, string | undefined> = process.env
): TraceCarrier | undefined {
  const traceparent = env.TRACEPARENT;
  if (traceparent === undefined || traceparent.length === 0) return undefined;
  return {
    traceparent,
    ...(env.BAGGAGE !== undefined && env.BAGGAGE.length > 0 ? { baggage: env.BAGGAGE } : {})
  };
}

export function withBaggage(
  carrier: TraceCarrier,
  entries: Record<string, string | number | undefined>
): TraceCarrier {
  const members = new Map<string, string>();
  for (const member of carrier.baggage?.split(",") ?? []) {
    const trimmed = member.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0) members.set(trimmed.slice(0, separator), trimmed);
  }
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      members.set(key, `${key}=${encodeURIComponent(String(value))}`);
    }
  }
  const baggage = [...members.values()].join(",");
  return { traceparent: carrier.traceparent, ...(baggage.length > 0 ? { baggage } : {}) };
}

export function baggageOf(
  carrier: TraceCarrier | undefined,
  keys: readonly string[]
): Record<string, string> {
  if (carrier?.baggage === undefined) return {};
  const wanted = new Set(keys);
  const output: Record<string, string> = {};
  for (const member of carrier.baggage.split(",")) {
    const pair = member.trim().split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator);
    if (wanted.has(key)) output[key] = decodeURIComponent(pair.slice(separator + 1));
  }
  return output;
}
