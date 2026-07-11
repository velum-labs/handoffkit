import { componentOfScope } from "./types";
import type { IncomingSpan } from "./types";

/**
 * OTLP/HTTP JSON trace parsing (`ExportTraceServiceRequest`).
 *
 * Two encodings arrive here: the OTel JS exporter's spec-conformant OTLP JSON
 * (hex ids, integer enums) and the Python engine's protobuf-JSON mapping
 * (base64 ids, enum name strings, int64s as strings). The decoder accepts
 * both — the OTLP spec explicitly allows a receiver to be liberal — and
 * flattens every span into the collector's `IncomingSpan` shape.
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
