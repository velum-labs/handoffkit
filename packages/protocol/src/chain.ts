import { hashCanonical } from "@routekit/contracts";
import type { ChainedEvent, RunEvent } from "./types.js";

function eventHash(input: {
  seq: number;
  ts: string;
  prev: string;
  event: RunEvent;
}): string {
  return hashCanonical(input);
}

/**
 * Append an event to a hash chain. The genesis event's `prev` is the
 * contract hash, which ties the whole chain to the signed contract.
 */
export function appendEvent(
  chain: ChainedEvent[],
  event: RunEvent,
  genesisPrev: string,
  now: () => string = () => new Date().toISOString()
): ChainedEvent {
  const last = chain[chain.length - 1];
  const seq = last ? last.seq + 1 : 0;
  const prev = last ? last.hash : genesisPrev;
  const ts = now();
  const chained: ChainedEvent = {
    version: "fusionkit.event.v1",
    seq,
    ts,
    prev,
    event,
    hash: eventHash({ seq, ts, prev, event })
  };
  chain.push(chained);
  return chained;
}

export type ChainVerification =
  | { ok: true }
  | { ok: false; brokenAtSeq: number; reason: string };

export function verifyChain(
  events: ChainedEvent[],
  genesisPrev: string
): ChainVerification {
  let expectedPrev = genesisPrev;
  for (let i = 0; i < events.length; i++) {
    const entry = events[i];
    if (!entry) return { ok: false, brokenAtSeq: i, reason: "missing entry" };
    if (entry.seq !== i) {
      return { ok: false, brokenAtSeq: i, reason: "sequence gap" };
    }
    if (entry.prev !== expectedPrev) {
      return { ok: false, brokenAtSeq: i, reason: "prev hash mismatch" };
    }
    const recomputed = eventHash({
      seq: entry.seq,
      ts: entry.ts,
      prev: entry.prev,
      event: entry.event
    });
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAtSeq: i, reason: "event hash mismatch" };
    }
    expectedPrev = entry.hash;
  }
  return { ok: true };
}
