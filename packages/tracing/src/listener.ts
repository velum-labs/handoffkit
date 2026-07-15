export {
  addEventListener as addFusionEventListener,
  addSpanListener,
  hasEventListeners as hasFusionEventListeners,
  hasSpanListeners,
  listenerLogRecordProcessor,
  listenerSpanProcessor,
  removeEventListener as removeFusionEventListener,
  removeSpanListener
} from "@routekit/tracing";
export type {
  EventListener as FusionEventListener,
  SpanListener
} from "@routekit/tracing";
