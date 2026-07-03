import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DriverRegistry,
  EventLog,
  HarnessError,
  PendingRequests,
  asHarnessError,
  createTrackedTmpDir,
  decideApproval,
  readCachedStatus,
  releaseTrackedTmpDir,
  statusSkipReason,
  sweepTrackedTmpDirs,
  toModelFusionErrorKind,
  toModelFusionHarnessKind,
  writeCachedStatus
} from "../index.js";
import type { HarnessEvent, HarnessStatus } from "../index.js";
import { createMockDriver, driverContractSuite } from "../testing/index.js";

// The mock driver is the reference implementation: it must pass the same
// contract suite every real driver is held against.
driverContractSuite({
  name: "mock driver",
  createInstance: async () => {
    const driver = createMockDriver();
    return driver.createInstance(driver.configSchema.parse({}));
  },
  startOptions: () => ({ cwd: process.cwd() }),
  supportsResume: true
});

test("registry decodes config exactly once and classifies failures", async () => {
  const registry = new DriverRegistry().register(createMockDriver());
  const instance = await registry.createInstance("generic", { replies: ["hi"] });
  assert.equal(instance.kind, "generic");
  await instance.dispose();

  await assert.rejects(
    registry.createInstance("generic", { replies: "not-an-array" }),
    (error: HarnessError) => error.code === "invalid_config"
  );
  await assert.rejects(
    registry.createInstance("codex", {}),
    (error: HarnessError) => error.code === "invalid_config"
  );
  assert.throws(() => registry.register(createMockDriver()), /already registered/);
});

test("error taxonomy derives retryability, category, and wire kind", () => {
  const timeout = new HarnessError("timeout", "deadline exceeded");
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.category, "transient");
  assert.equal(toModelFusionErrorKind(timeout), "timeout");

  const auth = new HarnessError("not_authenticated", "run codex login");
  assert.equal(auth.retryable, false);
  assert.equal(auth.category, "auth_permanent");
  assert.equal(toModelFusionErrorKind(auth), "capability_missing");

  const quota = new HarnessError("provider_error", "out of credits", {
    category: "quota_exhausted"
  });
  assert.equal(quota.retryable, true);
  assert.equal(toModelFusionErrorKind(quota), "rate_limited");

  const enoent = asHarnessError(
    Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
  );
  assert.equal(enoent.code, "not_installed");
});

test("approvals: policy verdicts and teardown settlement", async () => {
  assert.equal(decideApproval({ autoApprove: "all" }, "exec_command_approval"), "accept");
  assert.equal(decideApproval({ autoApprove: "all" }, "tool_user_input"), undefined);
  assert.equal(decideApproval({ autoApprove: "edits" }, "file_change_approval"), "accept");
  assert.equal(decideApproval({ autoApprove: "edits" }, "exec_command_approval"), undefined);
  assert.equal(decideApproval({ autoApprove: "none" }, "file_change_approval"), undefined);

  const pending = new PendingRequests();
  const first = pending.open({ requestType: "exec_command_approval", detail: "rm -rf" });
  const second = pending.open({ requestType: "tool_user_input" });
  assert.equal(pending.resolve(first.requestId, "decline"), true);
  assert.equal(await first.decision, "decline");
  assert.equal(pending.resolve(first.requestId, "accept"), false);
  assert.equal(pending.settleAll("cancel"), 1);
  assert.equal(await second.decision, "cancel");
});

test("status cache round-trips and rejects identity mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-status-"));
  try {
    const status: HarnessStatus = {
      kind: "codex",
      installed: true,
      command: "codex",
      version: "0.99.0",
      auth: { status: "authenticated" },
      checkedAt: new Date().toISOString()
    };
    writeCachedStatus(status, dir);
    assert.deepEqual(readCachedStatus("codex", dir), status);
    // The payload's kind, not the filename, is the routing key.
    assert.equal(readCachedStatus("cursor", dir), undefined);
    assert.equal(statusSkipReason(status), undefined);
    assert.match(
      statusSkipReason({ ...status, auth: { status: "unauthenticated" } }) ?? "",
      /not logged in/
    );
    assert.match(statusSkipReason({ ...status, installed: false }) ?? "", /not installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mock session surfaces approvals under autoApprove none and resolves them", async () => {
  const driver = createMockDriver();
  const instance = await driver.createInstance(
    driver.configSchema.parse({ approvalDetail: "npm test", replies: ["done"] })
  );
  const session = await instance.startSession({
    cwd: process.cwd(),
    approvalPolicy: { autoApprove: "none" }
  });
  const events: HarnessEvent[] = [];
  for await (const event of session.sendTurn({ prompt: "run tests" })) {
    events.push(event);
    if (event.type === "request.opened") {
      await session.respondToRequest(event.requestId, "accept");
    }
  }
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "turn.started",
    "request.opened",
    "request.resolved",
    "content.delta",
    "turn.completed"
  ]);
  await instance.dispose();
});

test("EventLog writes NDJSON per session and summarizes raw payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-log-"));
  try {
    const log = new EventLog({ dir });
    log.write({
      kind: "codex",
      sessionId: "sess/1",
      at: new Date().toISOString(),
      type: "content.delta",
      stream: "assistant_text",
      text: "hi",
      raw: { source: "codex.exec.json", method: "item.completed", payload: { a: 1, b: 2 } }
    });
    const contents = readFileSync(join(dir, "sess_1.ndjson"), "utf8").trim();
    const parsed = JSON.parse(contents) as {
      type: string;
      raw: { source: string; payload: { bytes: number; fields: number } };
    };
    assert.equal(parsed.type, "content.delta");
    // The raw payload is summarized to a shape, never written whole.
    assert.equal(parsed.raw.source, "codex.exec.json");
    assert.equal(parsed.raw.payload.fields, 2);
    assert.ok(parsed.raw.payload.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracked temp dirs are swept after a simulated crash", () => {
  const manifestDir = mkdtempSync(join(tmpdir(), "harness-manifest-"));
  const manifest = join(manifestDir, "tmp-manifest.json");
  try {
    const leaked = createTrackedTmpDir("harness-sweep-", manifest);
    const kept = createTrackedTmpDir("harness-sweep-", manifest);
    // A clean release drops one entry; the other is "leaked" by a crash.
    releaseTrackedTmpDir(kept, manifest);
    assert.equal(existsSync(kept), false);
    assert.equal(existsSync(leaked), true);
    const swept = sweepTrackedTmpDirs(manifest);
    assert.deepEqual(swept, [leaked]);
    assert.equal(existsSync(leaked), false);
    assert.deepEqual(sweepTrackedTmpDirs(manifest), []);
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
  }
});

test("kind mapping is exhaustive and opencode degrades to generic on the wire", () => {
  assert.equal(toModelFusionHarnessKind("codex"), "codex");
  assert.equal(toModelFusionHarnessKind("claude_code"), "claude_code");
  assert.equal(toModelFusionHarnessKind("cursor"), "cursor");
  assert.equal(toModelFusionHarnessKind("opencode"), "generic");
  assert.equal(toModelFusionHarnessKind("generic"), "generic");
});
