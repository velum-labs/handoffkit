import assert from "node:assert/strict";
import { test } from "node:test";

import { distillLog, freePort, spawnLogged, spawnTool, waitForHttp } from "@routekit/runtime";

const MISSING_BINARY = "fusionkit-definitely-not-a-real-binary-xyz";

test("freePort returns a usable ephemeral port", async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0);
});

test("freePort does not hand the same number to concurrent callers", async () => {
  const ports = await Promise.all(Array.from({ length: 8 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length, "all concurrently reserved ports must be distinct");
});

test("distillLog prefers error-looking lines over surrounding noise", () => {
  const log = [
    "resolving fusionkit@0.1.0",
    "building wheels...",
    "downloading numpy",
    "Error: invalid API key for provider openai",
    "extra trailing noise line"
  ].join("\n");
  const distilled = distillLog(log);
  assert.match(distilled, /invalid API key/);
});

test("distillLog falls back to head and tail when no errors are present", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const distilled = distillLog(lines.join("\n"), { maxLines: 6 });
  assert.match(distilled, /line 0/);
  assert.match(distilled, /line 39/);
  assert.match(distilled, /\.\.\./);
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
