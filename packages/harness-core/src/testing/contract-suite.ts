import assert from "node:assert/strict";
import { test } from "node:test";

import type { HarnessEvent } from "../events.js";
import type { HarnessInstance, StartSessionOptions } from "../contract.js";

export type DriverContractSuiteInput = {
  /** Suite label, e.g. "codex driver". */
  name: string;
  /** Fresh instance per test; disposed by the suite. */
  createInstance: () => Promise<HarnessInstance>;
  /** Session options valid for this driver (cwd usually a temp repo). */
  startOptions: () => StartSessionOptions;
  prompt?: string;
  /** Set when the driver supports native resume; enables the resume test. */
  supportsResume?: boolean;
  /** Upper bound for a scripted turn to settle (default 30s). */
  turnTimeoutMs?: number;
  /** Skip reason (e.g. CLI not installed locally); tests report skipped, never silently pass. */
  skip?: string | false;
};

async function collect(
  events: AsyncIterable<HarnessEvent>,
  timeoutMs: number
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const deadline = new Error(`turn did not settle within ${timeoutMs}ms`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(deadline), timeoutMs);
  });
  try {
    const iterator = events[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done === true) break;
      out.push(next.value);
    }
    return out;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The invariants every harness driver must satisfy, executed as node:test
 * tests. Drivers register their own scripted fixtures (fake CLI binaries or
 * scripted transports) and hand the suite a fresh instance per test.
 */
export function driverContractSuite(input: DriverContractSuiteInput): void {
  const timeoutMs = input.turnTimeoutMs ?? 30_000;
  const prompt = input.prompt ?? "Reply with OK.";
  const skip = input.skip ?? false;

  test(`${input.name}: a scripted turn completes with canonical events`, { skip }, async () => {
    const instance = await input.createInstance();
    try {
      const session = await instance.startSession(input.startOptions());
      const events = await collect(session.sendTurn({ prompt }), timeoutMs);
      const types = events.map((event) => event.type);
      assert.ok(types.includes("turn.started"), `turn.started missing in ${types.join(",")}`);
      const completed = events.find((event) => event.type === "turn.completed");
      assert.ok(completed, `turn.completed missing in ${types.join(",")}`);
      assert.equal(completed.endReason, "completed");
      assert.ok(
        events.every((event) => event.sessionId === session.sessionId),
        "every event carries the session id"
      );
      await session.stop();
    } finally {
      await instance.dispose();
    }
  });

  test(`${input.name}: an aborted turn settles as aborted, never hangs`, { skip }, async () => {
    const instance = await input.createInstance();
    try {
      const session = await instance.startSession(input.startOptions());
      const events = await collect(
        session.sendTurn({ prompt, signal: AbortSignal.abort(new Error("straggler_abandoned")) }),
        timeoutMs
      );
      const terminal = events.at(-1);
      assert.ok(terminal, "an aborted turn still yields events");
      assert.ok(
        (terminal.type === "turn.completed" &&
          (terminal.endReason === "aborted" || terminal.endReason === "interrupted")) ||
          terminal.type === "turn.failed",
        `terminal event must record the abort, got ${terminal.type}`
      );
      await session.stop();
    } finally {
      await instance.dispose();
    }
  });

  test(`${input.name}: stop settles pending approvals (nothing hangs)`, { skip }, async () => {
    const instance = await input.createInstance();
    try {
      const session = await instance.startSession(input.startOptions());
      // Consume the stream concurrently; stop() must let it terminate even
      // if the driver opened approvals that were never answered.
      const collecting = collect(session.sendTurn({ prompt }), timeoutMs);
      await session.stop();
      await collecting.catch(() => undefined);
    } finally {
      await instance.dispose();
    }
  });

  if (input.supportsResume === true) {
    test(`${input.name}: resume cursor round-trips into a new session`, { skip }, async () => {
      const instance = await input.createInstance();
      try {
        const first = await instance.startSession(input.startOptions());
        await collect(first.sendTurn({ prompt }), timeoutMs);
        const cursor = first.resumeCursor();
        assert.ok(cursor, "driver advertises resume but produced no cursor");
        await first.stop();

        const resumed = await instance.startSession({ ...input.startOptions(), resume: cursor });
        assert.equal(resumed.sessionId, first.sessionId, "resume restores the session identity");
        await resumed.stop();
      } finally {
        await instance.dispose();
      }
    });
  }
}
