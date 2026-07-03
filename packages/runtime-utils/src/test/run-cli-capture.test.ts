import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChildEnv, runCliCapture, sleep } from "../index.js";

/** A CLI that spawns its own grandchild (like codex/claude/cursor all do). */
const PARENT_WITH_GRANDCHILD = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("GRANDCHILD:" + grandchild.pid);
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}

test("runCliCapture kills the whole process tree on abort", async () => {
  const controller = new AbortController();
  let grandchildPid: number | undefined;
  const result = await runCliCapture(process.execPath, ["-e", PARENT_WITH_GRANDCHILD], {
    onStdoutLine: (line) => {
      if (line.startsWith("GRANDCHILD:")) {
        grandchildPid = Number(line.slice("GRANDCHILD:".length));
        controller.abort(new Error("straggler_abandoned"));
      }
    },
    signal: controller.signal
  });
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, "straggler_abandoned");
  assert.equal(result.exitCode, 130);
  assert.ok(grandchildPid !== undefined, "grandchild pid was reported");
  assert.ok(
    await waitForExit(grandchildPid, 5_000),
    "grandchild must die with the process group"
  );
});

test("runCliCapture kills the whole process tree on timeout", async () => {
  let grandchildPid: number | undefined;
  const result = await runCliCapture(process.execPath, ["-e", PARENT_WITH_GRANDCHILD], {
    onStdoutLine: (line) => {
      if (line.startsWith("GRANDCHILD:")) {
        grandchildPid = Number(line.slice("GRANDCHILD:".length));
      }
    },
    timeoutMs: 500
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.ok(grandchildPid !== undefined, "grandchild pid was reported");
  assert.ok(
    await waitForExit(grandchildPid, 5_000),
    "grandchild must die with the process group"
  );
});

test("runCliCapture short-circuits on an already-aborted signal", async () => {
  const result = await runCliCapture(process.execPath, ["-e", "process.exit(0)"], {
    signal: AbortSignal.abort(new Error("panel cancelled"))
  });
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, "panel cancelled");
  assert.equal(result.exitCode, 130);
});

test("runCliCapture delivers stdin and captures stdout/stderr/exit code", async () => {
  const lines: string[] = [];
  const result = await runCliCapture(
    process.execPath,
    [
      "-e",
      'let data = ""; process.stdin.on("data", (c) => (data += c)); process.stdin.on("end", () => { console.log("prompt:" + data); console.error("warn"); process.exit(3); });'
    ],
    { stdin: "hello panel", onStdoutLine: (line) => lines.push(line) }
  );
  assert.equal(result.stdout.trim(), "prompt:hello panel");
  assert.equal(result.stderr.trim(), "warn");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.deepEqual(lines, ["prompt:hello panel"]);
});

test("runCliCapture rejects on spawn failure", async () => {
  await assert.rejects(
    runCliCapture("definitely-not-a-real-binary-3141", [], {}),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
});

test("buildChildEnv forwards baseline and allowlisted vars only", () => {
  const env = buildChildEnv({
    base: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      OPENAI_API_KEY: "leak-me-not",
      ANTHROPIC_API_KEY: "allowed",
      CURSOR_CONFIG_DIR: "/tmp/cursor",
      RANDOM_SECRET: "leak-me-not"
    },
    allow: ["ANTHROPIC_API_KEY", /^CURSOR_/],
    extra: { CODEX_HOME: "/tmp/codex" }
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.ANTHROPIC_API_KEY, "allowed");
  assert.equal(env.CURSOR_CONFIG_DIR, "/tmp/cursor");
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(env, "RANDOM_SECRET"), false);
});
