import { componentOfScope } from "./types";
import type { IncomingEvent, IncomingSpan } from "./types";

/**
 * OTLP/HTTP JSON parsing: traces (`ExportTraceServiceRequest`) and logs
 * (`ExportLogsServiceRequest`, carrying fusion events as log records with
 * `eventName`).
 *
 * Two encodings arrive here: the OTel JS exporter's spec-conformant OTLP JSON
 * (hex ids, integer enums) and the Python engine's protobuf-JSON mapping
 * (base64 ids, enum name strings, int64s as strings). The decoders accept
 * both — the OTLP spec explicitly allows a receiver to be liberal — and
 * flatten every signal into the collector's incoming shapes.
 */

type AnyValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};

type KeyValue = { key?: string; value?: AnyValue };

type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: number | string;
  endTimeUnixNano?: number | string;
  attributes?: KeyValue[];
  status?: { code?: number | string; message?: string };
};

type ExportTraceServiceRequest = {
  resourceSpans?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: Array<{
      scope?: { name?: string };
      spans?: OtlpSpan[];
    }>;
  }>;
};

type OtlpLogRecord = {
  timeUnixNano?: number | string;
  observedTimeUnixNano?: number | string;
  eventName?: string;
  traceId?: string;
  spanId?: string;
  attributes?: KeyValue[];
};

type ExportLogsServiceRequest = {
  resourceLogs?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeLogs?: Array<{
      scope?: { name?: string };
      logRecords?: OtlpLogRecord[];
    }>;
  }>;
};

function decodeValue(value: AnyValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.intValue !== undefined) {
    const parsed = typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
    return Number.isFinite(parsed) ? parsed : value.intValue;
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map((item) => decodeValue(item));
  }
  if (value.kvlistValue !== undefined) {
    return decodeAttributes(value.kvlistValue.values ?? []);
  }
  return undefined;
}

function decodeAttributes(attributes: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of attributes ?? []) {
    if (entry.key === undefined) continue;
    const decoded = decodeValue(entry.value);
    if (decoded !== undefined) out[entry.key] = decoded;
  }
  return out;
}

/** Hex ids pass through; base64 (the protobuf-JSON mapping) is transcoded. */
function decodeId(raw: string | undefined, hexLength: number): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(raw)) return raw.toLowerCase();
  try {
    const hex = Buffer.from(raw, "base64").toString("hex");
    return hex.length === hexLength ? hex : undefined;
  } catch {
    return undefined;
  }
}

function decodeNanos(raw: number | string | undefined): number {
  const value = typeof raw === "string" ? Number(raw) : (raw ?? 0);
  return Number.isFinite(value) ? value / 1e6 : 0;
}

function decodeStatus(status: OtlpSpan["status"]): { status: IncomingSpan["status"]; message?: string } {
  const code = status?.code;
  const normalized =
    code === 1 || code === "STATUS_CODE_OK"
      ? "ok"
      : code === 2 || code === "STATUS_CODE_ERROR"
        ? "error"
        : "unset";
  return {
    status: normalized,
    ...(status?.message !== undefined && status.message.length > 0 ? { message: status.message } : {})
  };
}

/** Flatten an OTLP export request into collector spans. Malformed spans are skipped. */
export function parseOtlpExport(body: unknown): IncomingSpan[] {
  const request = (body ?? {}) as ExportTraceServiceRequest;
  const spans: IncomingSpan[] = [];
  for (const resourceSpan of request.resourceSpans ?? []) {
    const resource = decodeAttributes(resourceSpan.resource?.attributes);
    const service = typeof resource["service.name"] === "string" ? resource["service.name"] : undefined;
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const component = componentOfScope(scopeSpan.scope?.name);
      for (const span of scopeSpan.spans ?? []) {
        const traceId = decodeId(span.traceId, 32);
        const spanId = decodeId(span.spanId, 16);
        if (traceId === undefined || spanId === undefined || span.name === undefined) continue;
        const parentSpanId = decodeId(span.parentSpanId, 16);
        const { status, message } = decodeStatus(span.status);
        spans.push({
          trace_id: traceId,
          span_id: spanId,
          ...(parentSpanId !== undefined ? { parent_span_id: parentSpanId } : {}),
          name: span.name,
          component,
          ...(service !== undefined ? { service } : {}),
          start_ms: decodeNanos(span.startTimeUnixNano),
          end_ms: decodeNanos(span.endTimeUnixNano),
          status,
          ...(message !== undefined ? { status_message: message } : {}),
          attributes: decodeAttributes(span.attributes)
        });
      }
    }
  }
  return spans;
}

/**
 * Flatten an OTLP logs export into collector events. Records without an
 * `eventName` or a trace id are skipped — the collector groups everything by
 * trace, and only fusion events (named log records) are meaningful to it.
 */
export function parseOtlpLogsExport(body: unknown): IncomingEvent[] {
  const request = (body ?? {}) as ExportLogsServiceRequest;
  const events: IncomingEvent[] = [];
  for (const resourceLog of request.resourceLogs ?? []) {
    const resource = decodeAttributes(resourceLog.resource?.attributes);
    const service = typeof resource["service.name"] === "string" ? resource["service.name"] : undefined;
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      const component = componentOfScope(scopeLog.scope?.name);
      for (const record of scopeLog.logRecords ?? []) {
        const traceId = decodeId(record.traceId, 32);
        if (traceId === undefined || record.eventName === undefined || record.eventName.length === 0) continue;
        const spanId = decodeId(record.spanId, 16);
        const ts = decodeNanos(record.timeUnixNano ?? record.observedTimeUnixNano);
        events.push({
          trace_id: traceId,
          ...(spanId !== undefined ? { span_id: spanId } : {}),
          name: record.eventName,
          component,
          ...(service !== undefined ? { service } : {}),
          ts_ms: ts,
          attributes: decodeAttributes(record.attributes)
        });
      }
    }
  }
  return events;
}
