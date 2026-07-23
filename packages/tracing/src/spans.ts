/**
 * Typed span/event helpers over the fusion semantic conventions.
 *
 * Two shapes cover every emit site:
 *
 * - **Unit spans** (`startFusionSpan`) are real units of work — a turn, a
 *   candidate, a judge phase, a model call. They carry terminal summary
 *   attributes and end when the work ends. They ride the traces signal.
 * - **Events** (`emitFusionEvent`) are OTel events (log records with an
 *   `event_name`) for live point-in-time signals — trajectory steps, judge
 *   thinking, cost beats. They export immediately on the logs signal, which
 *   is what keeps the scope dashboard live while a unit span is still open.
 *
 * Trace identity crosses boundaries as a {@link FusionTraceCarrier}: the W3C
 * `traceparent`/`baggage` pair as plain data. The same carrier threads
 * through in-process values (PanelRunInput), HTTP headers, and child-process
 * environments (`TRACEPARENT`/`BAGGAGE`), so there is exactly one propagation
 * shape everywhere. Events emitted with a carrier inherit its trace/span ids.
 */
import {
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags
} from "@opentelemetry/api";
import type { Attributes, AttributeValue, Span } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { FUSION_SCOPES } from "@fusionkit/protocol";
import {
  baggageOf,
  carrierFromEnv,
  carrierFromHeaders,
  carrierOf,
  contextOf,
  envOf,
  headersOf,
  newSessionCarrier,
  newSpanId,
  newTraceId,
  sessionCarrier,
  traceIdOf,
  withBaggage
} from "@velum-labs/routekit-tracing";
import type { TraceCarrier } from "@velum-labs/routekit-tracing";

export type FusionScope = keyof typeof FUSION_SCOPES;

/**
 * Serializable trace context: the W3C header values as data. `traceparent`
 * is always present; `baggage` carries fusion correlation entries.
 */
export type FusionTraceCarrier = TraceCarrier;

export {
  carrierFromEnv,
  carrierFromHeaders,
  carrierOf,
  contextOf,
  envOf,
  headersOf,
  newSessionCarrier,
  newSpanId,
  newTraceId,
  sessionCarrier,
  traceIdOf
};

function tracerFor(scope: FusionScope) {
  return trace.getTracer(FUSION_SCOPES[scope]);
}

function loggerFor(scope: FusionScope) {
  return logs.getLogger(FUSION_SCOPES[scope]);
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
  return withBaggage(carrier, {
    [BAGGAGE_CANDIDATE]: entries.candidateId,
    [BAGGAGE_TRAJECTORY]: entries.trajectoryId,
    [BAGGAGE_TURN]: entries.turn
  });
}

/** Read fusion correlation entries out of a carrier's baggage. */
export function fusionBaggageOf(carrier: FusionTraceCarrier | undefined): FusionBaggage {
  const baggage = baggageOf(carrier, [BAGGAGE_CANDIDATE, BAGGAGE_TRAJECTORY, BAGGAGE_TURN]);
  const candidate = baggage[BAGGAGE_CANDIDATE];
  const trajectory = baggage[BAGGAGE_TRAJECTORY];
  const turnRaw = baggage[BAGGAGE_TURN];
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

// OTel spans are write-only: attributes cannot be read back, so appending to a
// list attribute needs per-span bookkeeping. WeakMap so finished spans free it.
const listAttributes = new WeakMap<Span, Map<string, string[]>>();

/**
 * Append `value` to the string-array attribute `key` of `span`. Duplicate
 * values are kept — each append is an occurrence.
 */
export function appendSpanListAttribute(span: Span, key: string, value: string): void {
  if (!span.isRecording()) return;
  let lists = listAttributes.get(span);
  if (lists === undefined) {
    lists = new Map();
    listAttributes.set(span, lists);
  }
  let list = lists.get(key);
  if (list === undefined) {
    list = [];
    lists.set(key, list);
  }
  list.push(value);
  span.setAttribute(key, [...list]);
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
 * Emit a fusion event: an OTel log record carrying `event_name`, the fusion
 * attributes, and the trace/span ids of `carrier`. This is the live-signal
 * primitive — events export immediately, independent of any open span. A
 * no-op when there is no carrier — a signal with no trace identity has no
 * consumer.
 */
export function emitFusionEvent(
  scope: FusionScope,
  name: string,
  carrier: FusionTraceCarrier | undefined,
  attributes: FusionAttributes
): void {
  if (carrier === undefined) return;
  loggerFor(scope).emit({
    eventName: name,
    severityNumber: SeverityNumber.INFO,
    attributes: compactAttributes(attributes) as LogAttributes,
    context: contextOf(carrier)
  });
}

/** A live unit-of-work span with its own carrier for parenting children. */
export type FusionSpan = {
  readonly span: Span;
  readonly traceId: string;
  readonly spanId: string;
  /** Carrier that parents children (events, child spans, HTTP calls) onto this span. */
  readonly carrier: FusionTraceCarrier;
  setAttributes(attributes: FusionAttributes): void;
  /** Emit a fusion event correlated to this span. */
  event(scope: FusionScope, name: string, attributes: FusionAttributes): void;
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
    event(eventScope: FusionScope, eventName: string, attrs: FusionAttributes): void {
      emitFusionEvent(eventScope, eventName, ownCarrier, attrs);
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

export { SpanKind, SpanStatusCode, TraceFlags };
