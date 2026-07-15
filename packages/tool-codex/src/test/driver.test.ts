import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { driverContractSuite } from "@routekit/harness-core/testing";
import type { HarnessEvent } from "@routekit/harness-core";

import { createCodexDriver } from "../driver.js";

/**
 * A fake `codex` CLI: honors `--version`, and for `exec --experimental-json`
 * reads the prompt from stdin and emits the JSONL event stream the codex-sdk
 * parses (thread.started, turn.started, item, turn.completed). `resume <id>`
 * reuses the given thread id so resume round-trips are observable.
 */
const FAKE_CODEX_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.142.5"); process.exit(0); }
const resumeIdx = args.indexOf("resume");
const threadId = resumeIdx >= 0 ? args[resumeIdx + 1] : "thread_fake_1";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.started", item: { id: "i1", type: "agent_message", text: "" } });
  emit({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "OK: " + input.trim() } });
  emit({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } });
  process.exit(0);
});
`;

function fakeCodexRepo(): { command: string; cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codex-driver-"));
  const command = join(dir, "codex-fake.mjs");
  writeFileSync(command, FAKE_CODEX_CLI);
  chmodSync(command, 0o755);
  return { command, cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const repo = fakeCodexRepo();

driverContractSuite({
  name: "codex driver",
  createInstance: async () => {
    const driver = createCodexDriver();
    const config = driver.configSchema.parse({ command: repo.command });
    return driver.createInstance(config);
  },
  startOptions: () => ({ cwd: repo.cwd, model: "gpt-5.1-codex" }),
  supportsResume: true,
  turnTimeoutMs: 15_000
});

test("codex driver maps the CLI event stream into canonical events", async () => {
  const driver = createCodexDriver();
  const instance = await driver.createInstance(driver.configSchema.parse({ command: repo.command }));
  try {
    const session = await instance.startSession({ cwd: repo.cwd });
    const events: HarnessEvent[] = [];
    for await (const event of session.sendTurn({ prompt: "hello codex" })) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    assert.ok(types.includes("session.started"));
    assert.ok(types.includes("turn.started"));
    const delta = events.find((event) => event.type === "content.delta");
    assert.ok(delta && delta.text.includes("hello codex"));
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(completed?.endReason, "completed");
    assert.equal(completed?.usage?.outputTokens, 2);
    // The real thread id from thread.started becomes the resume cursor.
    const cursor = session.resumeCursor();
    assert.equal((cursor?.data as { threadId?: string }).threadId, "thread_fake_1");
    // Every event carries the codex kind and the raw envelope is preserved.
    assert.ok(events.every((event) => event.kind === "codex"));
    assert.ok(events.some((event) => event.raw?.source === "codex.exec.json"));
  } finally {
    await instance.dispose();
    repo.cleanup();
  }
});

test("codex driver probe reports version and installed state", async () => {
  const driver = createCodexDriver();
  const repo2 = fakeCodexRepo();
  try {
    const status = await driver.probe({ env: { ...process.env } as Record<string, string> });
    // The default command "codex" may or may not be installed on the host, so
    // this only asserts the shape; the fake-command instance path is covered above.
    assert.equal(status.kind, "codex");
    assert.ok(typeof status.installed === "boolean");
  } finally {
    repo2.cleanup();
  }
});
