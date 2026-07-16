import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { driverContractSuite } from "@routekit/harness-core/testing";
import type { HarnessEvent } from "@routekit/harness-core";

import { createCursorDriver } from "../driver.js";

// The fake ACP agent lives beside this test in src (tsc does not copy .mjs),
// so resolve it relative to the compiled test's location back into src.
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "..", "..", "src", "test", "fake-acp-agent.mjs");

const driver = createCursorDriver();

// A wrapper executable so the driver's appended `acp` arg lands after the fake
// agent script: `<wrapper> acp` -> `node <fake-agent> acp`. `--version` is
// answered directly so the probe sees an installed CLI.
let cachedWrapper: string | undefined;
function wrapperCommand(): string {
  if (cachedWrapper !== undefined) return cachedWrapper;
  const dir = mkdtempSync(join(tmpdir(), "cursor-driver-"));
  const wrapper = join(dir, "cursor-agent-fake");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cursor-agent 2026.1.1"; exit 0; fi\nexec "${process.execPath}" "${FAKE_AGENT}" "$@"\n`
  );
  chmodSync(wrapper, 0o755);
  cachedWrapper = wrapper;
  return wrapper;
}

driverContractSuite({
  name: "cursor driver",
  createInstance: async () => driver.createInstance(driver.configSchema.parse({ command: wrapperCommand() })),
  startOptions: () => ({ cwd: here }),
  supportsResume: true,
  turnTimeoutMs: 15_000
});

test("cursor driver maps ACP session updates into canonical events", async () => {
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: wrapperCommand() })
  );
  try {
    const session = await instance.startSession({ cwd: here });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "hello cursor" })) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    assert.ok(types.includes("turn.started"));
    const delta = events.find((event) => event.type === "content.delta");
    assert.ok(delta && delta.text.includes("hello cursor"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    assert.ok(events.every((event) => event.kind === "cursor"));
    assert.ok(session.resumeCursor()?.data);
    await session.stop();
  } finally {
    await instance.dispose();
  }
});

test("cursor driver auto-approves under the automation policy", async () => {
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: wrapperCommand() })
  );
  try {
    // Automation policy (autoApprove:all) is the default: exec approval is granted
    // server-side without a surfaced request, so the turn completes.
    const session = await instance.startSession({ cwd: here });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "please APPROVE and continue" })) {
      events.push(event);
    }
    assert.ok(!events.some((event) => event.type === "request.opened"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    await session.stop();
  } finally {
    await instance.dispose();
  }
});

test("cursor driver surfaces approvals under autoApprove none and resolves them", async () => {
  const instance = await driver.createInstance(
    driver.configSchema.parse({ command: wrapperCommand() })
  );
  try {
    const session = await instance.startSession({
      cwd: here,
      approvalPolicy: { autoApprove: "none" }
    });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "please APPROVE and continue" })) {
      events.push(event);
      if (event.type === "request.opened") {
        assert.equal(event.requestType, "exec_command_approval");
        await session.respondToRequest(event.requestId, "accept");
      }
    }
    assert.ok(events.some((event) => event.type === "request.opened"));
    assert.ok(events.some((event) => event.type === "request.resolved"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    await session.stop();
  } finally {
    await instance.dispose();
  }
});
