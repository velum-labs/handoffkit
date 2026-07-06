/**
 * In-process span listener: a SpanProcessor that fans finished spans out to
 * subscribers synchronously. The gateway's reasoning narrator uses it to
 * narrate panel/judge progress into the client stream, and the CLI's product
 * telemetry uses it to fold sessions into allow-listed aggregates — neither
 * requires an OTLP endpoint to be configured.
 *
 * Markers are zero-duration spans, so "finished" fires the instant they are
 * emitted; unit spans fire at their natural end. A broken listener must never
 * break a run: exceptions are swallowed.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

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
