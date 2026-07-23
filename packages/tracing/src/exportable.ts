import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import { EXPORTABLE_ATTRIBUTES } from "@fusionkit/protocol";
import {
  isLoopbackOtlpEndpoint,
  PolicyLogExporter,
  PolicySpanExporter,
  toExportableEvent as applyEventPolicy,
  toExportableSpan
} from "@velum-labs/routekit-tracing";

export const TRACE_REDACTED_ATTRIBUTE = "fusion.trace.redacted";
const policy = {
  allowed: EXPORTABLE_ATTRIBUTES,
  redactedAttribute: TRACE_REDACTED_ATTRIBUTE
};

export const toExportable = (span: ReadableSpan): ReadableSpan =>
  toExportableSpan(span, policy);
export const toExportableEvent = (event: ReadableLogRecord): ReadableLogRecord =>
  applyEventPolicy(event, policy);

export type AllowlistSpanExporterOptions = { fullFidelity?: boolean };
export class AllowlistSpanExporter extends PolicySpanExporter {
  constructor(inner: SpanExporter, options: AllowlistSpanExporterOptions = {}) {
    super(inner, policy, options.fullFidelity ?? false);
  }
}

export type AllowlistLogExporterOptions = { fullFidelity?: boolean };
export class AllowlistLogExporter extends PolicyLogExporter {
  constructor(inner: LogRecordExporter, options: AllowlistLogExporterOptions = {}) {
    super(inner, policy, options.fullFidelity ?? false);
  }
}

export { isLoopbackOtlpEndpoint };
