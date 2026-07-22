import {
  flushTracing,
  initTracing,
  isEventExportConfigured,
  isTraceExportConfigured,
  isTracingActive,
  resetTracingForTest,
  shutdownTracing,
  tracingServiceName
} from "@routekit/tracing";
import type { LogRecordProcessor, SpanProcessor } from "@routekit/tracing";
import { EXPORTABLE_ATTRIBUTES } from "@fusionkit/protocol";

import { TRACE_REDACTED_ATTRIBUTE } from "./exportable.js";

export type InitFusionTracingOptions = {
  serviceName: string;
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
};

export function initFusionTracing(options: InitFusionTracingOptions): void {
  initTracing({
    ...options,
    attributePolicy: {
      allowed: EXPORTABLE_ATTRIBUTES,
      redactedAttribute: TRACE_REDACTED_ATTRIBUTE
    },
    fullFidelityEnvironmentVariable: "FUSIONKIT_TRACE_FULL_FIDELITY",
    logPrefix: "fusionkit tracing"
  });
}

export const fusionTracingServiceName = tracingServiceName;
export const isFusionTracingActive = isTracingActive;
export {
  flushTracing as flushFusionTracing,
  isEventExportConfigured,
  isTraceExportConfigured,
  resetTracingForTest as resetFusionTracingForTest,
  shutdownTracing as shutdownFusionTracing
};
