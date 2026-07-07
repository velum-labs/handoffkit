/**
 * Acceptance tests for the process supervisor (WS7.1).
 *
 * Contract: `superviseSpawn` runs a child in its own detached process group,
 * builds the child env through `buildChildEnv` by default (allowlist, never a
 * raw process.env inherit), and timeout/abort/kill all terminate the whole
 * group with SIGTERM -> SIGKILL escalation — a harness child that spawns its
 * own subprocesses can never leave orphans.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { superviseSpawn } from "../process.js";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("resolves done with the exit code of a clean child", async () => {
  const spawned = superviseSpawn(process.execPath, ["-e", "process.exit(3)"]);
  const exit = await spawned.done;
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.signal, null);
  assert.equal(exit.timedOut, false);
  assert.equal(exit.aborted, false);
});

test("kill() terminates the whole process group, grandchildren included", async () => {
  // The child prints its grandchild's pid, then both sleep. Killing the
  // supervisor handle must take down the grandchild too, not just the shell.
  const script = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn("sleep", ["600"], { stdio: "ignore" });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const spawned = superviseSpawn(process.execPath, ["-e", script]);
  let grandchildPid = 0;
  spawned.child.stdout?.on("data", (chunk: Buffer) => {
    if (grandchildPid === 0) grandchildPid = Number.parseInt(chunk.toString(), 10);
  });
  await waitFor(() => grandchildPid > 0);
  assert.equal(processAlive(grandchildPid), true);
  spawned.kill();
  await spawned.done;
  await waitFor(() => !processAlive(grandchildPid));
  assert.equal(processAlive(grandchildPid), false);
});

test("abort signal kills the group and marks the exit aborted", async () => {
  const controller = new AbortController();
  const spawned = superviseSpawn("sleep", ["600"], { signal: controller.signal });
  controller.abort(new Error("straggler grace expired"));
  const exit = await spawned.done;
  assert.equal(exit.aborted, true);
  assert.equal(processAlive(spawned.pid), false);
});

test("an already-aborted signal never starts the child", async () => {
  const controller = new AbortController();
  controller.abort();
  const spawned = superviseSpawn("sleep", ["600"], { signal: controller.signal });
  const exit = await spawned.done;
  assert.equal(exit.aborted, true);
});

test("timeout SIGTERMs, then escalates to SIGKILL when the child ignores it", async () => {
  // The child traps SIGTERM and keeps running; only the SIGKILL escalation
  // can end it. Tight grace keeps the test fast.
  const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const started = Date.now();
  const spawned = superviseSpawn(process.execPath, ["-e", script], {
    timeoutMs: 300,
    graceMs: 300
  });
  const exit = await spawned.done;
  assert.equal(exit.timedOut, true);
  assert.equal(exit.signal, "SIGKILL");
  assert.ok(Date.now() - started < 5_000, "escalation happened promptly");
});

test("child env goes through buildChildEnv by default: secrets do not leak", async () => {
  process.env.FUSIONKIT_TEST_SECRET_WS7 = "leak-me";
  try {
    const spawned = superviseSpawn(process.execPath, [
      "-e",
      'console.log(JSON.stringify({ secret: process.env.FUSIONKIT_TEST_SECRET_WS7 ?? null, path: process.env.PATH !== undefined }))'
    ]);
    let output = "";
    spawned.child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exit = await spawned.done;
    assert.equal(exit.exitCode, 0);
    const observed = JSON.parse(output) as { secret: string | null; path: boolean };
    assert.equal(observed.secret, null, "unallowlisted var must not reach the child");
    assert.equal(observed.path, true, "baseline vars like PATH still flow");
  } finally {
    delete process.env.FUSIONKIT_TEST_SECRET_WS7;
  }
});

test("extra env entries reach the child without opening the rest of process.env", async () => {
  const spawned = superviseSpawn(
    process.execPath,
    ["-e", "console.log(process.env.FUSION_EXTRA ?? '')"],
    { extraEnv: { FUSION_EXTRA: "value-1" } }
  );
  let output = "";
  spawned.child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  await spawned.done;
  assert.equal(output.trim(), "value-1");
});
