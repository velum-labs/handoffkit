import assert from "node:assert/strict";
import { test } from "node:test";

import { driverContractSuite } from "@routekit/harness-core/testing";
import type { HarnessEvent } from "@routekit/harness-core";

import { createOpencodeDriver } from "../driver.js";
import type { OpencodeBackend, OpencodeBackendFactory } from "../driver.js";

/** A scripted opencode backend: echoes the prompt, no server required. */
function fakeBackend(): OpencodeBackend {
  let counter = 0;
  return {
    createSession: async ({ resume }) => ({ sessionId: resume ?? `opencode-session-${++counter}` }),
    prompt: async ({ prompt, signal }) => {
      if (signal?.aborted === true) throw new Error("aborted");
      return {
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "bash", callId: "call-1", status: "completed" },
          { type: "text", text: `echo: ${prompt}` },
          { type: "step-finish", tokens: { input: 4, output: 2, reasoning: 1 } }
        ]
      };
    },
    abort: async () => undefined,
    dispose: async () => undefined
  };
}

const backendFactory: OpencodeBackendFactory = async () => fakeBackend();
const driver = createOpencodeDriver({ backendFactory });
const config = (): unknown => ({ gatewayUrl: "http://127.0.0.1:9999" });

driverContractSuite({
  name: "opencode driver",
  createInstance: async () => driver.createInstance(driver.configSchema.parse(config())),
  startOptions: () => ({ cwd: process.cwd() }),
  supportsResume: true,
  turnTimeoutMs: 10_000
});

test("opencode driver maps buffered parts into canonical events", async () => {
  const instance = await driver.createInstance(driver.configSchema.parse(config()));
  try {
    const session = await instance.startSession({ cwd: process.cwd() });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "hello opencode" })) {
      events.push(event);
    }
    const deltas = events.filter((event) => event.type === "content.delta");
    assert.ok(deltas.some((event) => event.stream === "assistant_text" && event.text.includes("hello opencode")));
    assert.ok(deltas.some((event) => event.stream === "reasoning_text"));
    const toolItem = events.find((event) => event.type === "item.completed");
    assert.equal(toolItem?.itemType, "command_execution");
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    assert.equal(completed?.usage?.outputTokens, 2);
    assert.ok(events.every((event) => event.kind === "opencode"));
    await session.stop();
  } finally {
    await instance.dispose();
  }
});

test("opencode driver forwards an opaque effort as the SDK variant", async () => {
  let observed: unknown;
  const effortDriver = createOpencodeDriver({
    backendFactory: async () => ({
      ...fakeBackend(),
      prompt: async (input) => {
        observed = input.reasoning;
        return { parts: [] };
      }
    })
  });
  const instance = await effortDriver.createInstance(
    effortDriver.configSchema.parse(config())
  );
  try {
    const session = await instance.startSession({
      cwd: process.cwd(),
      reasoning: { mode: "effort", effort: "deep" }
    });
    for await (const _event of session.sendTurn({ prompt: "hello" })) {
      // Drain.
    }
    assert.deepEqual(observed, { mode: "effort", effort: "deep" });
  } finally {
    await instance.dispose();
  }
});
