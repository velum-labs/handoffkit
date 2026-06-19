import assert from "node:assert/strict";
import { test } from "node:test";

import { freePort, spawnLogged, spawnTool, waitForHttp } from "../shared/proc.js";

const MISSING_BINARY = "warrant-definitely-not-a-real-binary-xyz";

test("freePort returns a usable ephemeral port", async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0);
});

test("spawnTool resolves with the child's exit code", async () => {
  assert.equal(await spawnTool(process.execPath, ["-e", "process.exit(3)"], {}), 3);
});

test("spawnTool rejects instead of crashing when the binary is missing", async () => {
  await assert.rejects(() => spawnTool(MISSING_BINARY, [], {}));
});

test("waitForHttp surfaces a missing-binary spawn error with a clear message", async () => {
  const proc = spawnLogged(MISSING_BINARY, ["serve"]);
  await assert.rejects(
    () => waitForHttp("http://127.0.0.1:1/", proc, { timeoutMs: 2000, label: "ghost service" }),
    /ghost service failed to start/
  );
});

test("waitForHttp reports when the child exits before becoming ready", async () => {
  const proc = spawnLogged(process.execPath, ["-e", "process.exit(1)"]);
  await assert.rejects(
    () => waitForHttp("http://127.0.0.1:1/", proc, { timeoutMs: 3000, label: "shortlived" }),
    /exited|failed to start/
  );
});
