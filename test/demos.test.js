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
  for (const entry of MANIFEST.demos) {
    assert.match(result.stdout, new RegExp(`\\b${entry.id}\\b`), `demo ${entry.id} must be listed`);
  }
});

test("unknown demo ids fail with the list", () => {
  const result = demo(["99"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown demo/);
});

test("demo 15 (runtime kernel) composes and replays a fusion graph", () => {
  const result = demo(["15"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime kernel/i);
  assert.match(result.stdout, /replay/i);
});
