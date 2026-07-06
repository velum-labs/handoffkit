/**
 * Typed span helpers over the fusion semantic conventions.
 *
 * Two shapes cover every emit site:
 *
 * - **Unit spans** (`startFusionSpan`) are real units of work — a turn, a
 *   candidate, a judge phase, a model call. They carry terminal summary
 *   attributes and end when the work ends.
 * - **Markers** (`emitFusionMarker`) are zero-duration spans for live
 *   point-in-time signals — trajectory steps, judge thinking, cost beats.
 *   Because OTLP only exports ended spans, markers are what keep the scope
 *   dashboard live while a unit span is still open.
 *
 * Trace identity crosses boundaries as a {@link FusionTraceCarrier}: the W3C
 * `traceparent`/`baggage` pair as plain data. The same carrier threads
 * through in-process values (PanelRunInput), HTTP headers, and child-process
 * environments (`TRACEPARENT`/`BAGGAGE`), so there is exactly one propagation
 * shape everywhere.
 */
import { randomBytes } from "node:crypto";

import {
  context as apiContext,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags
} from "@opentelemetry/api";
import type { Attributes, AttributeValue, Context, Span } from "@opentelemetry/api";
import { FUSION_SCOPES } from "@fusionkit/protocol";

export type FusionScope = keyof typeof FUSION_SCOPES;

/**
 * Serializable trace context: the W3C header values as data. `traceparent`
 * is always present; `baggage` carries fusion correlation entries.
 */
export type FusionTraceCarrier = {
  traceparent: string;
  baggage?: string;
};

function tracerFor(scope: FusionScope) {
  return trace.getTracer(FUSION_SCOPES[scope]);
}

/** 32-hex OTel trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 16-hex OTel span id. */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Mint a session identity: a fresh trace with a virtual (never-exported)
 * session root span. Every turn in the session parents onto this carrier, so
 * multi-turn sessions stay correlated without holding a long-lived span open.
 */
export function newSessionCarrier(): { traceId: string; carrier: FusionTraceCarrier } {
  const traceId = newTraceId();
  return {
    traceId,
    carrier: { traceparent: `00-${traceId}-${newSpanId()}-01` }
  };
}

/** Rebuild an OTel Context from a carrier (or the root context when absent). */
export function contextOf(carrier: FusionTraceCarrier | undefined): Context {
  if (carrier === undefined) return apiContext.active();
  return propagation.extract(apiContext.active(), carrier, {
    get: (c, key) => (c as Record<string, string | undefined>)[key],
    keys: (c) => Object.keys(c as Record<string, string>)
  });
}

/** Serialize a Context back into a carrier. */
export function carrierOf(ctx: Context): FusionTraceCarrier {
  const target: Record<string, string> = {};
  propagation.inject(ctx, target, {
    set: (c, key, value) => {
      c[key] = value;
    }
  });
  const traceparent = target.traceparent;
  if (traceparent === undefined) {
    // No recording span in the context: mint a fresh identity so downstream
    // signals still correlate somewhere rather than vanishing.
    return newSessionCarrier().carrier;
  }
  return { traceparent, ...(target.baggage !== undefined ? { baggage: target.baggage } : {}) };
}

/** The trace id encoded in a carrier. */
export function traceIdOf(carrier: FusionTraceCarrier): string {
  const parts = carrier.traceparent.split("-");
  return parts[1] ?? "";
}

/** Extract a carrier from incoming HTTP headers (case-insensitive). */
export function carrierFromHeaders(
  headers: Record<string, string | string[] | undefined>
): FusionTraceCarrier | undefined {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const traceparent = first(headers.traceparent);
  if (traceparent === undefined || traceparent.length === 0) return undefined;
  const baggage = first(headers.baggage);
  return { traceparent, ...(baggage !== undefined && baggage.length > 0 ? { baggage } : {}) };
}

/** The carrier as outgoing HTTP headers. */
export function headersOf(carrier: FusionTraceCarrier): Record<string, string> {
  return {
    traceparent: carrier.traceparent,
    ...(carrier.baggage !== undefined ? { baggage: carrier.baggage } : {})
  };
}

/** The carrier as child-process environment variables. */
export function envOf(carrier: FusionTraceCarrier): Record<string, string> {
  return {
    TRACEPARENT: carrier.traceparent,
    ...(carrier.baggage !== undefined ? { BAGGAGE: carrier.baggage } : {})
  };
}

/** A carrier from the ambient environment (set by a parent fusion process). */
export function carrierFromEnv(env: NodeJS.ProcessEnv = process.env): FusionTraceCarrier | undefined {
  const traceparent = env.TRACEPARENT;
  if (traceparent === undefined || traceparent.length === 0) return undefined;
  return {
    traceparent,
    ...(env.BAGGAGE !== undefined && env.BAGGAGE.length > 0 ? { baggage: env.BAGGAGE } : {})
  };
}

export type FusionBaggage = {
  candidateId?: string;
  trajectoryId?: string;
  turn?: number;
};

const BAGGAGE_CANDIDATE = "fusion.candidate.id";
const BAGGAGE_TRAJECTORY = "fusion.trajectory.id";
const BAGGAGE_TURN = "fusion.turn";

/** Return a carrier with fusion correlation entries added to its baggage. */
export function withFusionBaggage(carrier: FusionTraceCarrier, entries: FusionBaggage): FusionTraceCarrier {
  const ctx = contextOf(carrier);
  const existing = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  let updated = existing;
  if (entries.candidateId !== undefined) {
    updated = updated.setEntry(BAGGAGE_CANDIDATE, { value: encodeURIComponent(entries.candidateId) });
  }
  if (entries.trajectoryId !== undefined) {
    updated = updated.setEntry(BAGGAGE_TRAJECTORY, { value: encodeURIComponent(entries.trajectoryId) });
  }
  if (entries.turn !== undefined) {
    updated = updated.setEntry(BAGGAGE_TURN, { value: String(entries.turn) });
  }
  return carrierOf(propagation.setBaggage(ctx, updated));
}

/** Read fusion correlation entries out of a carrier's baggage. */
export function fusionBaggageOf(carrier: FusionTraceCarrier | undefined): FusionBaggage {
  if (carrier?.baggage === undefined) return {};
  const ctx = contextOf(carrier);
  const baggage = propagation.getBaggage(ctx);
  if (baggage === undefined) return {};
  const candidate = baggage.getEntry(BAGGAGE_CANDIDATE)?.value;
  const trajectory = baggage.getEntry(BAGGAGE_TRAJECTORY)?.value;
  const turnRaw = baggage.getEntry(BAGGAGE_TURN)?.value;
  const turn = turnRaw !== undefined ? Number(turnRaw) : undefined;
  return {
    ...(candidate !== undefined ? { candidateId: decodeURIComponent(candidate) } : {}),
    ...(trajectory !== undefined ? { trajectoryId: decodeURIComponent(trajectory) } : {}),
    ...(turn !== undefined && Number.isFinite(turn) ? { turn } : {})
  };
}

/** JSON-stringify a structured value into an attribute (undefined passes through). */
export function jsonAttr(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Drop undefined values so callers can build attribute bags inline. */
function compactAttributes(attributes: Record<string, AttributeValue | undefined>): Attributes {
  const compact: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) compact[key] = value;
  }
  return compact;
}

export type FusionAttributes = Record<string, AttributeValue | undefined>;

/**
 * Emit an instant marker span: started and ended at the same timestamp,
 * parented onto `carrier`. This is the live-signal primitive.
 */
export function emitFusionMarker(
  scope: FusionScope,
  name: string,
  carrier: FusionTraceCarrier | undefined,
  attributes: FusionAttributes
): void {
  const span = tracerFor(scope).startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes: compactAttributes(attributes) },
    contextOf(carrier)
  );
  span.end();
}

/** A live unit-of-work span with its own carrier for parenting children. */
export type FusionSpan = {
  readonly span: Span;
  readonly traceId: string;
  readonly spanId: string;
  /** Carrier that parents children (markers, child spans, HTTP calls) onto this span. */
  readonly carrier: FusionTraceCarrier;
  setAttributes(attributes: FusionAttributes): void;
  /** Emit a marker parented onto this span. */
  marker(scope: FusionScope, name: string, attributes: FusionAttributes): void;
  /** End the span with a status. `error` also records an exception message. */
  end(input?: { status?: "succeeded" | "failed" | "skipped"; error?: string; attributes?: FusionAttributes }): void;
};

/** Start a real unit-of-work span parented onto `carrier` (root when absent). */
export function startFusionSpan(
  scope: FusionScope,
  name: string,
  carrier: FusionTraceCarrier | undefined,
  attributes: FusionAttributes = {}
): FusionSpan {
  const parentCtx = contextOf(carrier);
  const span = tracerFor(scope).startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes: compactAttributes(attributes) },
    parentCtx
  );
  const spanContext = span.spanContext();
  const ownCtx = trace.setSpan(parentCtx, span);
  const ownCarrier = carrierOf(ownCtx);
  let ended = false;
  return {
    span,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    carrier: ownCarrier,
    setAttributes(attrs: FusionAttributes): void {
      span.setAttributes(compactAttributes(attrs));
    },
    marker(markerScope: FusionScope, markerName: string, attrs: FusionAttributes): void {
      emitFusionMarker(markerScope, markerName, ownCarrier, attrs);
    },
    end(input): void {
      if (ended) return;
      ended = true;
      if (input?.attributes !== undefined) span.setAttributes(compactAttributes(input.attributes));
      if (input?.status !== undefined) span.setAttribute("fusion.status", input.status);
      if (input?.error !== undefined || input?.status === "failed") {
        span.setStatus({ code: SpanStatusCode.ERROR, ...(input?.error !== undefined ? { message: input.error } : {}) });
        if (input?.error !== undefined) span.setAttribute("fusion.error", input.error);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    }
  };
}

/**
 * A non-exported placeholder carrier for signals with no ambient trace (the
 * emitter still needs a valid parent so ids are well-formed).
 */
export function ephemeralCarrier(): FusionTraceCarrier {
  return newSessionCarrier().carrier;
}

export { SpanKind, SpanStatusCode, TraceFlags };
