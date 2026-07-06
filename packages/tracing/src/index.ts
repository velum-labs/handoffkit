/**
 * @fusionkit/tracing — OpenTelemetry-based tracing for the fusion stack.
 *
 * The engine is the OTel SDK (ids, W3C propagation, batching, flush, OTLP
 * export); this package owns the thin domain layer: typed span helpers over
 * the fusion semantic conventions (spec/fusion-trace/registry.json), the
 * serializable trace carrier that threads context through values, HTTP
 * headers, and child environments, and the in-process span listener the
 * narrator and product telemetry subscribe to.
 */
export {
  flushFusionTracing,
  fusionTracingServiceName,
  initFusionTracing,
  isTraceExportConfigured,
  resetFusionTracingForTest,
  shutdownFusionTracing
} from "./provider.js";
export type { InitFusionTracingOptions } from "./provider.js";
export { addSpanListener, hasSpanListeners, listenerSpanProcessor, removeSpanListener } from "./listener.js";
export type { SpanListener } from "./listener.js";
export {
  carrierFromEnv,
  carrierFromHeaders,
  carrierOf,
  contextOf,
  emitFusionMarker,
  envOf,
  ephemeralCarrier,
  fusionBaggageOf,
  headersOf,
  jsonAttr,
  newSessionCarrier,
  newSpanId,
  newTraceId,
  startFusionSpan,
  traceIdOf,
  withFusionBaggage
} from "./spans.js";
export type {
  FusionAttributes,
  FusionBaggage,
  FusionScope,
  FusionSpan,
  FusionTraceCarrier
} from "./spans.js";
export { attrBool, attrJson, attrNum, attrStr, spanEndMs, spanId, spanTraceId } from "./readable.js";
export type { ReadableSpan } from "./readable.js";
export {
  ATTR,
  EXPORTABLE_ATTRIBUTES,
  FUSION_CONVENTIONS_VERSION,
  FUSION_MARKER_NAMES,
  FUSION_SCOPES,
  FUSION_SPAN_NAMES,
  FUSION_UNIT_SPAN_NAMES
} from "@fusionkit/protocol";
export type { FusionAttributeKey, FusionMarkerName, FusionSpanName } from "@fusionkit/protocol";
