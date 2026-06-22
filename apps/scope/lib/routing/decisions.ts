/**
 * In-process pub/sub for live routing decisions. The SSE `/api/routing/decisions`
 * endpoint subscribes here; publishers call {@link publishRoutingDecision} (or
 * POST the same payload to that route). A ring buffer replays recent decisions
 * to new subscribers.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { RoutingDecision, RoutingDecisionEvent } from "./types";

const MAX_BUFFER = 200;

const globalForRouting = globalThis as unknown as {
  __scopeRoutingBus?: EventEmitter;
  __scopeRoutingBuffer?: RoutingDecisionEvent[];
};

function bus(): EventEmitter {
  if (globalForRouting.__scopeRoutingBus === undefined) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    globalForRouting.__scopeRoutingBus = emitter;
  }
  return globalForRouting.__scopeRoutingBus;
}

function buffer(): RoutingDecisionEvent[] {
  if (globalForRouting.__scopeRoutingBuffer === undefined) {
    globalForRouting.__scopeRoutingBuffer = [];
  }
  return globalForRouting.__scopeRoutingBuffer;
}

/** Subscribe to routing decisions (used by the SSE handler). */
export function onRoutingDecision(listener: (event: RoutingDecisionEvent) => void): () => void {
  const emitter = bus();
  const handler = (event: RoutingDecisionEvent): void => listener(event);
  emitter.on("routing.decision", handler);
  return () => emitter.off("routing.decision", handler);
}

/** Recent decisions for replay when a client connects. */
export function recentRoutingDecisions(limit = 50): RoutingDecisionEvent[] {
  const events = buffer();
  return events.slice(Math.max(0, events.length - limit));
}

function isRoutingDecision(value: unknown): value is RoutingDecision {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.scenario !== "string") return false;
  if (typeof record.tokenCount !== "number") return false;
  if (typeof record.reason !== "string") return false;
  if (typeof record.fallbackIndex !== "number") return false;
  if (typeof record.target !== "object" || record.target === null) return false;
  const target = record.target as Record<string, unknown>;
  return typeof target.model === "string";
}

/**
 * Publish a routing decision to live subscribers and the replay buffer.
 * Returns the enriched event (with id + timestamp).
 */
export function publishRoutingDecision(decision: RoutingDecision): RoutingDecisionEvent {
  const event: RoutingDecisionEvent = {
    ...decision,
    id: randomUUID(),
    ts: Date.now() / 1000
  };
  const buf = buffer();
  buf.push(event);
  if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
  bus().emit("routing.decision", event);
  return event;
}

/** Parse and publish when the payload looks like a routing decision. */
export function tryPublishRoutingDecision(value: unknown): RoutingDecisionEvent | undefined {
  if (!isRoutingDecision(value)) return undefined;
  return publishRoutingDecision(value);
}
