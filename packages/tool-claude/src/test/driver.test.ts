import assert from "node:assert/strict";
import { test } from "node:test";

import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { driverContractSuite } from "@routekit/harness-core/testing";
import type { HarnessEvent } from "@routekit/harness-core";

import { createClaudeDriver } from "../driver.js";
import type { ClaudeQueryFn } from "../driver.js";

const usage = { input_tokens: 5, output_tokens: 3 } as SDKMessage extends { usage: infer U } ? U : never;

/**
 * A scripted stand-in for the Agent SDK `query`: emits a system/init, an
 * assistant text block echoing the prompt, invokes canUseTool when the prompt
 * asks to APPROVE, and finishes with a result. Honors the abort controller so
 * the aborted-turn contract holds.
 */
function scriptedQuery(sessionId = "claude-session-1"): ClaudeQueryFn {
  return ({ prompt, options }: { prompt: string; options: Options }): Query => {
    const controller = options.abortController;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId
      } as unknown as SDKMessage;
      if (controller?.signal.aborted === true) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      if (prompt.includes("APPROVE") && options.canUseTool !== undefined) {
        const result = await options.canUseTool("Bash", { command: "npm test" }, {
          signal: controller?.signal ?? new AbortController().signal,
          toolUseID: "tool-use-1"
        });
        if (result.behavior === "deny") {
          yield {
            type: "result",
            subtype: "error_during_execution",
            usage,
            session_id: sessionId
          } as unknown as SDKMessage;
          return;
        }
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: `echo: ${prompt}` }] },
        session_id: sessionId
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        result: `echo: ${prompt}`,
        usage,
        session_id: sessionId
      } as unknown as SDKMessage;
    }
    const generator = run();
    const query = generator as unknown as Query;
    (query as { interrupt: () => Promise<void> }).interrupt = async () => {
      controller?.abort();
    };
    return query;
  };
}

const driver = createClaudeDriver({ queryFn: scriptedQuery() });

driverContractSuite({
  name: "claude driver",
  createInstance: async () => driver.createInstance(driver.configSchema.parse({ command: "claude" })),
  startOptions: () => ({ cwd: process.cwd() }),
  supportsResume: true,
  turnTimeoutMs: 10_000
});

test("claude driver maps SDK messages into canonical events", async () => {
  const instance = await driver.createInstance(driver.configSchema.parse({ command: "claude" }));
  try {
    const session = await instance.startSession({ cwd: process.cwd() });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "hello claude" })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === "session.started"));
    const delta = events.find((event) => event.type === "content.delta");
    assert.ok(delta && delta.text.includes("hello claude"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    assert.equal(session.resumeCursor()?.data && (session.resumeCursor()?.data as { sessionId?: string }).sessionId, "claude-session-1");
    assert.ok(events.every((event) => event.kind === "claude_code"));
    await session.stop();
  } finally {
    await instance.dispose();
  }
});

test("claude driver forwards opaque effort through SDK options", async () => {
  let observed: Options | undefined;
  const delegate = scriptedQuery("claude-reasoning-session");
  const effortDriver = createClaudeDriver({
    queryFn: (input) => {
      observed = input.options;
      return delegate(input);
    }
  });
  const instance = await effortDriver.createInstance(
    effortDriver.configSchema.parse({ command: "claude" })
  );
  try {
    const session = await instance.startSession({
      cwd: process.cwd(),
      reasoning: { mode: "effort", effort: "deep" }
    });
    for await (const _event of session.sendTurn({ prompt: "reason deeply" })) {
      // Drain.
    }
    assert.deepEqual(observed?.thinking, { type: "adaptive" });
    assert.equal(observed?.effort, "deep");
  } finally {
    await instance.dispose();
  }
});

test("claude driver auto-approves tools under the automation policy", async () => {
  const instance = await driver.createInstance(driver.configSchema.parse({ command: "claude" }));
  try {
    const session = await instance.startSession({ cwd: process.cwd() });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "please APPROVE the tool" })) {
      events.push(event);
    }
    assert.ok(!events.some((event) => event.type === "request.opened"));
    assert.equal(events.find((event) => event.type === "turn.completed")?.endReason, "completed");
    await session.stop();
  } finally {
    await instance.dispose();
  }
});

test("claude driver surfaces approvals under autoApprove none and resolves them", async () => {
  const instance = await driver.createInstance(driver.configSchema.parse({ command: "claude" }));
  try {
    const session = await instance.startSession({
      cwd: process.cwd(),
      approvalPolicy: { autoApprove: "none" }
    });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "please APPROVE the tool" })) {
      events.push(event);
      if (event.type === "request.opened") {
        assert.equal(event.requestType, "exec_command_approval");
        await session.respondToRequest(event.requestId, "accept");
      }
    }
    assert.ok(events.some((event) => event.type === "request.opened"));
    assert.ok(events.some((event) => event.type === "request.resolved"));
    assert.equal(events.find((event) => event.type === "turn.completed")?.endReason, "completed");
    await session.stop();
  } finally {
    await instance.dispose();
  }
});
