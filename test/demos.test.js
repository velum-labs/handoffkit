import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RUN = "scripts/demo.mjs";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../examples/manifest.json", import.meta.url), "utf8")
);

function demo(args) {
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

test("the demo dispatcher lists every example in the manifest", () => {
  const result = demo([]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(MANIFEST.demos.length >= 13, "manifest must keep the demo series");
  for (const entry of MANIFEST.demos) {
    assert.match(result.stdout, new RegExp(`\\b${entry.id}\\b`), `demo ${entry.id} must be listed`);
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

test("demo 09 (AI SDK loop) executes governed tool calls with receipts", () => {
  const result = demo(["09"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /receipt verified offline: true/);
  assert.match(result.stdout, /3 data rows/);
});

test("demo 10 (compute sandbox) composes commands across sessions", () => {
  const result = demo(["10"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /continuity via the workspace/);
  assert.match(result.stdout, /receipt verified: true/);
});

test("demo 11 (golden interface) journals tools and carries them across the boundary", () => {
  const result = demo(["11"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pinned via the envelope inside the signed contract/);
  assert.match(result.stdout, /tool calls: {4}1/);
});

test("demo 12 (model escalation) escalates deterministically and continues", () => {
  const result = demo(["12"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ESCALATED/);
  assert.match(result.stdout, /after escalation → true/);
  assert.match(result.stdout, /1 escalation\(s\)/);
});

test("demo 13 (hermetic session) runs in the interpreter and blocks egress", () => {
  const result = demo(["13"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolation: hermetic/);
  assert.match(result.stdout, /command not found|BLOCKED/);
});

test("demo 14 (swarm) dispatches governed workers, catches overlap, and escalates", () => {
  const result = demo(["14"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dispatched 2 governed worker/);
  assert.match(result.stdout, /verdict: accepted/);
  assert.match(result.stdout, /verdict: escalate/);
  assert.match(result.stdout, /overlaps already-pulled/);
  assert.match(result.stdout, /receipt verified: true/);
});

test("demo 15 (runtime kernel) composes and replays a fusion graph", () => {
  const result = demo(["15"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime kernel/i);
  assert.match(result.stdout, /replay/i);
});
