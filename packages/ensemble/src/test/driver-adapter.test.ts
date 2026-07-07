import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockDriver } from "@fusionkit/harness-core/testing";
import type { ResumeCursor } from "@fusionkit/harness-core";

import { createDriverHarness } from "../driver-adapter.js";
import { ensemble } from "../run.js";
import type { EnsembleDescriptor } from "../harness.js";

// A real scratch repo so the driver harness runs candidates in isolated
// worktrees (it now hard-errors rather than falling back to process.cwd(), and
// the add-then-diff stays confined to disposable worktrees off this repo).
function makeRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "driver-adapter-repo-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@fusionkit.dev"]);
  git(["config", "user.name", "FusionKit Test"]);
  writeFileSync(join(dir, "README.md"), "scratch\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  return { dir, sha };
}

function tempOutputRoot(): {
  outputRoot: string;
  workspace: string;
  sha: string;
  cleanup: () => void;
} {
  const outputRoot = mkdtempSync(join(tmpdir(), "driver-adapter-out-"));
  const repo = makeRepo();
  return {
    outputRoot,
    workspace: repo.dir,
    sha: repo.sha,
    cleanup: () => {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  };
}

function descriptor(
  outputRoot: string,
  workspace: string,
  sha: string,
  harness: EnsembleDescriptor["harness"]
): EnsembleDescriptor {
  return {
    id: "driver_adapter_test",
    harness,
    models: [{ id: "m1", model: "mock-model" }],
    runtime: { id: "local" },
    judge: { id: "judge", model: "fake-judge" },
    policy: {
      id: "policy",
      allowedTools: ["read_file"],
      sideEffects: "read_only",
      timeoutMs: 5_000
    },
    prompt: "summarize the plan",
    sourceRepo: "handoffkit",
    baseGitSha: sha,
    workspace,
    outputRoot
  };
}

test("driver bridge runs a panel candidate with a reconstructed trajectory", async () => {
  const { outputRoot, workspace, sha, cleanup } = tempOutputRoot();
  const driver = createMockDriver();
  const harness = createDriverHarness({
    driver,
    fusionBackendUrl: "http://127.0.0.1:9999",
    configForModel: () => driver.configSchema.parse({ replies: ["fused answer"] })
  });
  try {
    const result = await ensemble.run(descriptor(outputRoot, workspace, sha, harness));
    assert.equal(result.harnessRunResult.status, "succeeded");
    const candidate = result.candidates[0];
    assert.equal(candidate?.status, "succeeded");
    assert.equal(candidate?.harness_kind, "generic");
    // The candidate must not be the "produced no trajectory" failure placeholder
    // (proven directly at the output level in the next test).
    assert.notEqual(candidate?.status, "failed");
  } finally {
    cleanup();
  }
});

test("driver bridge reconstructs trajectory steps from canonical events", async () => {
  const driver = createMockDriver();
  const harness = createDriverHarness({
    driver,
    fusionBackendUrl: "http://127.0.0.1:9999",
    configForModel: () =>
      driver.configSchema.parse({ replies: ["the fused answer"], approvalDetail: "npm test" })
  });
  const prepared = await harness.prepare({
    descriptor: {} as never,
    request: {} as never
  });
  // A throwaway workspace instead of process.cwd(): the harness runs (and does
  // its add-then-diff) here so the test never stages the real repo's index.
  const workspace = mkdtempSync(join(tmpdir(), "driver-adapter-ws-"));
  try {
    const output = await harness.run({
      descriptor: {
        id: "d",
        prompt: "do the thing",
        models: [{ id: "m1", model: "mock" }],
        workspace
      } as never,
      request: {} as never,
      model: { id: "m1", model: "mock" },
      ordinal: 0,
      prepared
    });
    assert.equal(output.status, "succeeded");
    assert.ok(output.trajectory, "a candidate must carry a trajectory for the fuse step");
    const steps = output.trajectory?.steps ?? [];
    // A tool observation (from the auto-approved exec) and the final output step.
    assert.ok(steps.some((step) => step.type === "output" && (step.text ?? "").includes("fused answer")));
    assert.equal(output.trajectory?.finalOutput.includes("the fused answer"), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("driver bridge resumes each member's native session across turns", async () => {
  const { outputRoot, workspace, sha, cleanup } = tempOutputRoot();
  const driver = createMockDriver();
  // One resume map for the whole conversation (as the gateway owns per session).
  const resumeCursors = new Map<string, ResumeCursor>();
  const makeHarness = () =>
    createDriverHarness({
      driver,
      fusionBackendUrl: "http://127.0.0.1:9999",
      // The mock driver replies replies[min(turnCount, len-1)]: a resumed
      // session advances turnCount, so turn two only says "turn two" if the
      // native session was resumed rather than started fresh.
      configForModel: () => driver.configSchema.parse({ replies: ["turn one", "turn two"] }),
      resumeCursors
    });
  try {
    const first = await ensemble.run(descriptor(outputRoot, workspace, sha, makeHarness()));
    assert.equal(first.candidates[0]?.status, "succeeded");

    const cursor = resumeCursors.get("m1");
    assert.ok(cursor, "a resume cursor was captured for the model after turn one");
    assert.equal(cursor.kind, "generic");
    const afterTurnOne = cursor.data as { sessionId?: string; turnCount?: number };
    assert.ok(afterTurnOne.sessionId);
    assert.equal(afterTurnOne.turnCount, 1);

    await ensemble.run(descriptor(outputRoot, workspace, sha, makeHarness()));
    // Native resume: same session id, and the turn count advanced (the second
    // run resumed the mock session rather than starting a fresh one).
    const afterTurnTwo = resumeCursors.get("m1")?.data as { sessionId?: string; turnCount?: number };
    assert.equal(afterTurnTwo.sessionId, afterTurnOne.sessionId);
    assert.equal(afterTurnTwo.turnCount, 2);
  } finally {
    cleanup();
  }
});
