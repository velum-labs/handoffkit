/**
 * In-process signal listeners: a SpanProcessor that fans finished spans out
 * to subscribers synchronously, and a LogRecordProcessor twin that fans
 * emitted fusion events out the same way. The gateway's reasoning narrator
 * uses them to narrate panel/judge progress into the client stream, and the
 * CLI's product telemetry uses them to fold sessions into allow-listed
 * aggregates — neither requires an OTLP endpoint to be configured.
 *
 * Events are emitted point-in-time, so "onEmit" fires the instant they are
 * emitted; unit spans fire at their natural end. A broken listener must never
 * break a run: exceptions are swallowed.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";

import type { ReadableFusionEvent } from "./readable.js";

export type SpanListener = (span: ReadableSpan) => void;

const listeners = new Set<SpanListener>();

export function addSpanListener(listener: SpanListener): void {
  listeners.add(listener);
}

export function removeSpanListener(listener: SpanListener): void {
  listeners.delete(listener);
}

/** True when anything in-process is observing spans. */
export function hasSpanListeners(): boolean {
  return listeners.size > 0;
}

class ListenerSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    for (const listener of listeners) {
      try {
        listener(span);
      } catch {
        // a broken listener must never break a run
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

export function listenerSpanProcessor(): SpanProcessor {
  return new ListenerSpanProcessor();
}

export type FusionEventListener = (record: ReadableFusionEvent) => void;

const eventListeners = new Set<FusionEventListener>();

export function addFusionEventListener(listener: FusionEventListener): void {
  eventListeners.add(listener);
}

export function removeFusionEventListener(listener: FusionEventListener): void {
  eventListeners.delete(listener);
}

/** True when anything in-process is observing fusion events. */
export function hasFusionEventListeners(): boolean {
  return eventListeners.size > 0;
}

class ListenerLogRecordProcessor implements LogRecordProcessor {
  onEmit(record: SdkLogRecord, _context?: Context): void {
    for (const listener of eventListeners) {
      try {
        listener(record);
      } catch {
        // a broken listener must never break a run
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

export function listenerLogRecordProcessor(): LogRecordProcessor {
  return new ListenerLogRecordProcessor();
}
