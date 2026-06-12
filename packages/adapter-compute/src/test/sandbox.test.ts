import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";

import { handoff, localFirst } from "@warrant/handoff";
import { makeRepo, startStack } from "@warrant/testkit";
import type { Stack } from "@warrant/testkit";

import { governedCompute, withCompute } from "../sandbox.js";
import type { GovernedSandbox } from "../sandbox.js";

const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;
let sandbox: GovernedSandbox;

before(async () => {
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    policy: (policy) => {
      policy.agents.allow = ["command"];
    }
  });
  repoDir = makeRepo({ files: { "README.md": "# sandbox fixture\n" } });
  const compute = governedCompute({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    pool: POOL,
    actor: { kind: "human", id: "sandbox-user" }
  });
  sandbox = await compute.sandbox.create();
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

test("staged files are visible to commands; outputs persist across commands", async () => {
  await sandbox.filesystem.writeFile("task.md", "build the report\nwith two lines\n");

  const first = await sandbox.runCommand(
    "cat task.md | wc -l | tr -d ' ' > lines.txt && cat lines.txt"
  );
  assert.equal(first.status, "completed");
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.trim(), "2");

  // Sequential composition: the second command sees the first one's output.
  const second = await sandbox.runCommand("cat lines.txt && echo done >> log.txt");
  assert.equal(second.status, "completed");
  assert.equal(second.output.trim(), "2");

  assert.equal(await sandbox.filesystem.readFile("lines.txt"), "2\n");
  assert.equal(await sandbox.filesystem.exists("log.txt"), true);

  const runs = sandbox.runs();
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.receiptVerified, true, "every command carries a verified receipt");
    assert.match(run.contractHash, /^[0-9a-f]{64}$/);
    assert.equal(run.sandboxId, sandbox.sandboxId);
  }
  assert.notEqual(runs[0]?.runId, runs[1]?.runId);
});

test("failing commands report their exit code and keep their receipt", async () => {
  const failed = await sandbox.runCommand("ls /nonexistent-path-zz");
  assert.equal(failed.status, "failed");
  assert.notEqual(failed.exitCode, 0);
  assert.ok(failed.output.length > 0, "stderr is captured in the session log");
  const last = sandbox.runs().at(-1);
  assert.ok(last);
  assert.equal(last.receiptVerified, true);
});

test("paths cannot escape the sandbox workspace", async () => {
  await assert.rejects(() => sandbox.filesystem.writeFile("../escape.txt", "nope"));
  await assert.rejects(() => sandbox.filesystem.readFile("/etc/hostname"));
});

test("withCompute attaches the compute surface to an existing context with one shared trace", async () => {
  const sharedRepo = makeRepo({ files: { "README.md": "# golden compute\n" } });
  try {
    const h = withCompute(
      handoff({
        workspace: sharedRepo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        policy: localFirst({ allowPools: [POOL] })
      }),
      { pool: POOL }
    );
    const box = await h.compute.sandbox.create();
    const result = await box.runCommand("echo golden > golden.txt && cat golden.txt");
    assert.equal(result.status, "completed");
    assert.equal(result.output.trim(), "golden");
    assert.equal(await box.filesystem.readFile("golden.txt"), "golden\n");

    // The sandbox command and the context share one trace and one summary.
    const types = h.trace().map((e) => e.type);
    assert.ok(types.includes("envelope.created"));
    assert.ok(types.includes("results.pulled"));
    const summary = await h.summary();
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0]?.status, "completed");
  } finally {
    rmSync(sharedRepo, { recursive: true, force: true });
  }
});

test("destroyed sandboxes refuse further operations", async () => {
  await sandbox.destroy();
  await assert.rejects(
    () => sandbox.runCommand("echo too-late"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /destroyed/);
      return true;
    }
  );
  await assert.rejects(() => sandbox.filesystem.readFile("task.md"));
});
