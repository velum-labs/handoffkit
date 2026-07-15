import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";

import type { ReadableEvent } from "./readable.js";

export type SpanListener = (span: ReadableSpan) => void;
export type EventListener = (event: ReadableEvent) => void;
const spanListeners = new Set<SpanListener>();
const eventListeners = new Set<EventListener>();

export const addSpanListener = (listener: SpanListener): void => void spanListeners.add(listener);
export const removeSpanListener = (listener: SpanListener): void => void spanListeners.delete(listener);
export const hasSpanListeners = (): boolean => spanListeners.size > 0;
export const addEventListener = (listener: EventListener): void => void eventListeners.add(listener);
export const removeEventListener = (listener: EventListener): void => void eventListeners.delete(listener);
export const hasEventListeners = (): boolean => eventListeners.size > 0;

class ListenerSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}
  onEnd(span: ReadableSpan): void {
    for (const listener of spanListeners) {
      try {
        listener(span);
      } catch {
        // Observers cannot fail the operation being observed.
      }
    }
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class ListenerLogRecordProcessor implements LogRecordProcessor {
  onEmit(record: SdkLogRecord, _context?: Context): void {
    for (const listener of eventListeners) {
      try {
        listener(record);
      } catch {
        // Observers cannot fail the operation being observed.
      }
    }
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export const listenerSpanProcessor = (): SpanProcessor => new ListenerSpanProcessor();
export const listenerLogRecordProcessor = (): LogRecordProcessor =>
  new ListenerLogRecordProcessor();
