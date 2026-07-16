import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

export type AttributePolicy = {
  allowed: ReadonlySet<string>;
  redactedAttribute: string;
};

function filterAttributes(
  attributes: Attributes,
  policy: AttributePolicy
): { kept: Attributes; dropped: number } {
  const kept: Attributes = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (policy.allowed.has(key)) kept[key] = value;
    else dropped += 1;
  }
  return { kept, dropped };
}

export function toExportableSpan(span: ReadableSpan, policy: AttributePolicy): ReadableSpan {
  const own = filterAttributes(span.attributes, policy);
  let childDrops = 0;
  const events = span.events.map((event) => {
    if (event.attributes === undefined) return event;
    const filtered = filterAttributes(event.attributes, policy);
    childDrops += filtered.dropped;
    return filtered.dropped === 0 ? event : { ...event, attributes: filtered.kept };
  });
  const links = span.links.map((link) => {
    if (link.attributes === undefined) return link;
    const filtered = filterAttributes(link.attributes, policy);
    childDrops += filtered.dropped;
    return filtered.dropped === 0 ? link : { ...link, attributes: filtered.kept };
  });
  if (own.dropped + childDrops === 0) return span;
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: { ...own.kept, [policy.redactedAttribute]: true },
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

export function toExportableEvent(
  record: ReadableLogRecord,
  policy: AttributePolicy
): ReadableLogRecord {
  const filtered = filterAttributes(record.attributes as Attributes, policy);
  if (filtered.dropped === 0) return record;
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
    attributes: { ...filtered.kept, [policy.redactedAttribute]: true },
    droppedAttributesCount: record.droppedAttributesCount + filtered.dropped
  };
}

export class PolicySpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly policy: AttributePolicy,
    private readonly fullFidelity = false
  ) {}
  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(
      this.fullFidelity ? spans : spans.map((span) => toExportableSpan(span, this.policy)),
      callback
    );
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class PolicyLogExporter implements LogRecordExporter {
  constructor(
    private readonly inner: LogRecordExporter,
    private readonly policy: AttributePolicy,
    private readonly fullFidelity = false
  ) {}
  export(records: ReadableLogRecord[], callback: Parameters<LogRecordExporter["export"]>[1]): void {
    this.inner.export(
      this.fullFidelity ? records : records.map((event) => toExportableEvent(event, this.policy)),
      callback
    );
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}

export function isLoopbackOtlpEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined || endpoint.length === 0) return false;
  try {
    const hostname = new URL(endpoint).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}
