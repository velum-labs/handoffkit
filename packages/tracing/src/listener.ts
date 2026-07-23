export {
  addEventListener as addFusionEventListener,
  addSpanListener,
  hasEventListeners as hasFusionEventListeners,
  hasSpanListeners,
  listenerLogRecordProcessor,
  listenerSpanProcessor,
  removeEventListener as removeFusionEventListener,
  removeSpanListener
} from "@velum-labs/routekit-tracing";
export type {
  EventListener as FusionEventListener,
  SpanListener
} from "@velum-labs/routekit-tracing";
