/**
 * @fusionkit/tracing — OpenTelemetry-based tracing for the fusion stack.
 *
 * The engine is the OTel SDK (ids, W3C propagation, batching, flush, OTLP
 * export); this package owns the thin domain layer: typed span and event
 * helpers over the fusion semantic conventions
 * (spec/fusion-trace/registry.json), the serializable trace carrier that
 * threads context through values, HTTP headers, and child environments, and
 * the in-process span/event listeners the narrator and product telemetry
 * subscribe to.
 */
export {
  flushFusionTracing,
  fusionTracingServiceName,
  initFusionTracing,
  isEventExportConfigured,
  isFusionTracingActive,
  isTraceExportConfigured,
  resetFusionTracingForTest,
  shutdownFusionTracing
} from "./provider.js";
export type { InitFusionTracingOptions } from "./provider.js";
export {
  addFusionEventListener,
  addSpanListener,
  hasFusionEventListeners,
  hasSpanListeners,
  listenerLogRecordProcessor,
  listenerSpanProcessor,
  removeFusionEventListener,
  removeSpanListener
} from "./listener.js";
export type { FusionEventListener, SpanListener } from "./listener.js";
export {
  appendSpanListAttribute,
  carrierFromEnv,
  carrierFromHeaders,
  carrierOf,
  contextOf,
  emitFusionEvent,
  envOf,
  fusionBaggageOf,
  headersOf,
  jsonAttr,
  newSessionCarrier,
  newSpanId,
  newTraceId,
  sessionCarrier,
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
export {
  AllowlistLogExporter,
  AllowlistSpanExporter,
  isLoopbackOtlpEndpoint,
  toExportable,
  toExportableEvent,
  TRACE_REDACTED_ATTRIBUTE
} from "./exportable.js";
export type { AllowlistLogExporterOptions, AllowlistSpanExporterOptions } from "./exportable.js";
export {
  attrBool,
  attrJson,
  attrNum,
  attrStr,
  eventNameOf,
  eventSpanId,
  eventTimeMs,
  eventTraceId,
  spanEndMs,
  spanId,
  spanTraceId
} from "./readable.js";
export type { AttributeSource, ReadableFusionEvent, ReadableSpan } from "./readable.js";
// Test support: capture finished spans/events in memory (used by consumer
// packages' tests; re-exported so they need no direct OTel dependency).
export {
  InMemoryLogRecordExporter,
  InMemorySpanExporter,
  SimpleLogRecordProcessor,
  SimpleSpanProcessor
} from "@routekit/tracing";
export type { LogRecordProcessor, SpanProcessor } from "@routekit/tracing";
export {
  ATTR,
  EXPORTABLE_ATTRIBUTES,
  FUSION_CONVENTIONS_VERSION,
  FUSION_EVENT_NAMES,
  FUSION_SCOPES,
  FUSION_SPAN_NAMES
} from "@fusionkit/protocol";
export type { FusionAttributeKey, FusionEventName, FusionSpanName } from "@fusionkit/protocol";
