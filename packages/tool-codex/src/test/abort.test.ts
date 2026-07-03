import assert from "node:assert/strict";
import { test } from "node:test";

import { codexEndReason, defaultCodexRunner } from "../harness.js";

test("defaultCodexRunner kills the child when its signal aborts", async () => {
  const controller = new AbortController();
  const run = defaultCodexRunner({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30_000)"],
    cwd: process.cwd(),
    env: {},
    signal: controller.signal
  });
  setTimeout(() => controller.abort(new Error("straggler_abandoned")), 50);
  const result = await run;
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, "straggler_abandoned");
  assert.equal(result.exitCode, 130);
});

test("defaultCodexRunner short-circuits on an already-aborted signal", async () => {
  const result = await defaultCodexRunner({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30_000)"],
    cwd: process.cwd(),
    env: {},
    signal: AbortSignal.abort(new Error("panel cancelled"))
  });
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, "panel cancelled");
});

test("codexEndReason maps an aborted result to kind aborted with the reason", () => {
  const reason = codexEndReason({
    stdout: "",
    stderr: "",
    exitCode: 130,
    aborted: true,
    abortReason: "straggler_abandoned"
  });
  assert.equal(reason.kind, "aborted");
  assert.equal(reason.detail, "straggler_abandoned");
});
