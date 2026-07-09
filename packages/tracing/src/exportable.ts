/**
 * Attribute redaction at the OTLP export boundary.
 *
 * Spans and events carry full-fidelity payloads (prompts, messages,
 * trajectories, final outputs) for in-process consumers — the reasoning
 * narrator and the local dashboard need them. But the protocol's
 * `EXPORTABLE_ATTRIBUTES` allowlist defines what is "safe to leave the
 * machine", so anything crossing a network boundary to a non-loopback
 * collector is filtered here, at the exporter, not at creation.
 */
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import { EXPORTABLE_ATTRIBUTES } from "@fusionkit/protocol";

/** Stamped onto spans that had attributes dropped, so dashboards can say why data is missing. */
export const TRACE_REDACTED_ATTRIBUTE = "fusion.trace.redacted";

function filterAttributes(attributes: Attributes): { kept: Attributes; dropped: number } {
  const kept: Attributes = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (EXPORTABLE_ATTRIBUTES.has(key)) kept[key] = value;
    else dropped += 1;
  }
  return { kept, dropped };
}

/**
 * Return a copy of the span with only `EXPORTABLE_ATTRIBUTES` retained (on
 * the span itself, its events, and its links). If nothing was dropped, the
 * original span is returned unchanged; otherwise the copy carries
 * `fusion.trace.redacted: true`.
 */
export function toExportable(span: ReadableSpan): ReadableSpan {
  const own = filterAttributes(span.attributes);
  let droppedInChildren = 0;
  const events = span.events.map((event) => {
    if (event.attributes === undefined) return event;
    const filtered = filterAttributes(event.attributes);
    droppedInChildren += filtered.dropped;
    return filtered.dropped === 0 ? event : { ...event, attributes: filtered.kept };
  });
  const links = span.links.map((link) => {
    if (link.attributes === undefined) return link;
    const filtered = filterAttributes(link.attributes);
    droppedInChildren += filtered.dropped;
    return filtered.dropped === 0 ? link : { ...link, attributes: filtered.kept };
  });
  const totalDropped = own.dropped + droppedInChildren;
  if (totalDropped === 0) return span;
  const attributes: Attributes = { ...own.kept, [TRACE_REDACTED_ATTRIBUTE]: true };
  // ReadableSpan implementations keep state behind prototype getters, so a
  // spread would silently lose fields; copy every interface member explicitly.
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes,
    links,
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount + own.dropped,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount
  };
}

export type AllowlistSpanExporterOptions = {
  /** Skip filtering entirely (loopback collector or explicit user opt-in). */
  fullFidelity?: boolean;
};

/**
 * A `SpanExporter` decorator that applies the `EXPORTABLE_ATTRIBUTES`
 * allowlist to every span before delegating to the wrapped exporter.
 */
export class AllowlistSpanExporter implements SpanExporter {
  readonly #inner: SpanExporter;
  readonly #fullFidelity: boolean;

  constructor(inner: SpanExporter, options: AllowlistSpanExporterOptions = {}) {
    this.#inner = inner;
    this.#fullFidelity = options.fullFidelity ?? false;
  }

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    const outgoing = this.#fullFidelity ? spans : spans.map(toExportable);
    this.#inner.export(outgoing, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Return a copy of the log record with only `EXPORTABLE_ATTRIBUTES` retained.
 * If nothing was dropped, the original record is returned unchanged;
 * otherwise the copy carries `fusion.trace.redacted: true`.
 */
export function toExportableEvent(record: ReadableLogRecord): ReadableLogRecord {
  const { kept, dropped } = filterAttributes(record.attributes as Attributes);
  if (dropped === 0) return record;
  return {
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    ...(record.spanContext !== undefined ? { spanContext: record.spanContext } : {}),
    ...(record.severityText !== undefined ? { severityText: record.severityText } : {}),
    ...(record.severityNumber !== undefined ? { severityNumber: record.severityNumber } : {}),
    ...(record.body !== undefined ? { body: record.body } : {}),
    ...(record.eventName !== undefined ? { eventName: record.eventName } : {}),
    resource: record.resource,
    instrumentationScope: record.instrumentationScope,
    attributes: { ...kept, [TRACE_REDACTED_ATTRIBUTE]: true },
    droppedAttributesCount: record.droppedAttributesCount + dropped
  };
}

export type AllowlistLogExporterOptions = {
  /** Skip filtering entirely (loopback collector or explicit user opt-in). */
  fullFidelity?: boolean;
};

/**
 * A `LogRecordExporter` decorator that applies the `EXPORTABLE_ATTRIBUTES`
 * allowlist to every event before delegating to the wrapped exporter.
 */
export class AllowlistLogExporter implements LogRecordExporter {
  readonly #inner: LogRecordExporter;
  readonly #fullFidelity: boolean;

  constructor(inner: LogRecordExporter, options: AllowlistLogExporterOptions = {}) {
    this.#inner = inner;
    this.#fullFidelity = options.fullFidelity ?? false;
  }

  export(records: ReadableLogRecord[], resultCallback: Parameters<LogRecordExporter["export"]>[1]): void {
    const outgoing = this.#fullFidelity ? records : records.map(toExportableEvent);
    this.#inner.export(outgoing, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }
}

/**
 * True when the OTLP endpoint targets the local machine, in which case spans
 * never leave it and redaction would only degrade the local dashboard.
 */
export function isLoopbackOtlpEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined || endpoint.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
