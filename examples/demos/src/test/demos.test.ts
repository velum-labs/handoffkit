import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUN = fileURLToPath(new URL("../run.js", import.meta.url));

function demo(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [RUN, ...args], {
    encoding: "utf8",
    timeout: 120_000
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

test("the series lists every demo", () => {
  const result = demo([]);
  assert.equal(result.status, 0, result.stderr);
  for (const id of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
    assert.match(result.stdout, new RegExp(`\\b${id}\\b`), `demo ${id} must be listed`);
  }
});

test("unknown demo ids fail with the list", () => {
  const result = demo(["99"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown demo/);
});

test("demo 01 (governed run) completes and verifies", () => {
  const result = demo(["01"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /receipt verified offline/);
});

test("demo 05 (offline verify) detects both attacks", () => {
  const result = demo(["05"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VERIFIED/);
  const detections = result.stdout.match(/detected:/g) ?? [];
  assert.equal(detections.length, 2);
});

test("demo 06 (handoff) continues local work and pulls it back", () => {
  const result = demo(["06"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /became governed run/);
  assert.match(result.stdout, /pull mode: applied/);
});
