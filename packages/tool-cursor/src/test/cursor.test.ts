import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockHarness, ensemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor } from "@fusionkit/ensemble";

import { cursorHarness } from "../index.js";
import type { CursorExecRunner } from "../index.js";

function tempOutputRoot(): { outputRoot: string; cleanup: () => void } {
  const outputRoot = mkdtempSync(join(tmpdir(), "ensemble-cursor-out-"));
  return {
    outputRoot,
    cleanup: () => rmSync(outputRoot, { recursive: true, force: true })
  };
}

function descriptor(
  outputRoot: string,
  overrides: Partial<EnsembleDescriptor> = {}
): EnsembleDescriptor {
  return {
    id: "cursor_ensemble_test",
    harness: createMockHarness(),
    models: [{ id: "cursor", model: "fusion-panel" }],
    runtime: { id: "local" },
    judge: { id: "judge", model: "fake-judge" },
    policy: {
      id: "policy",
      allowedTools: ["read_file", "apply_patch", "run_shell"],
      sideEffects: "writes_workspace",
      timeoutMs: 1_000
    },
    prompt: "Fix the failing test in the repo.",
    sourceRepo: "handoffkit",
    baseGitSha: "b".repeat(40),
    outputRoot,
    ...overrides
  };
}

test("cursor adapter skips clearly when the Cursor CLI is unavailable", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: cursorHarness({ env: { PATH: "" } })
      })
    );

    assert.equal(result.harnessRunResult.status, "skipped");
    assert.equal(result.candidates[0]?.status, "skipped");
    assert.equal(result.candidates[0]?.error?.kind, "capability_missing");
    assert.match(
      result.candidates[0]?.error?.message ?? "",
      /Cursor CLI .* was not found on PATH/
    );
  } finally {
    cleanup();
  }
});

test("cursor adapter produces a real candidate with a diff via the injected runner", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  let observedMode: string | undefined;
  let observedBackend: string | undefined;
  const runner: CursorExecRunner = (input) => {
    observedMode = input.mode;
    observedBackend = input.fusionBackendUrl;
    return {
      status: "succeeded",
      transcript: "Applied the fix and verified the tests pass.",
      diff: "--- a/calc.ts\n+++ b/calc.ts\n@@ -1,1 +1,1 @@\n-return a - b;\n+return a + b;",
      toolEvents: 3
    };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: cursorHarness({
          fusionBackendUrl: "http://127.0.0.1:9999",
          runner
        })
      })
    );

    assert.equal(observedMode, "agent");
    assert.equal(observedBackend, "http://127.0.0.1:9999");
    assert.equal(result.harnessRunResult.status, "succeeded");
    const candidate = result.candidates[0];
    assert.equal(candidate?.status, "succeeded");
    assert.equal(candidate?.metadata?.adapter, "cursor");
    assert.equal(candidate?.metadata?.tool_events, 3);
    assert.equal(candidate?.metadata?.has_diff, true);
    assert.ok(
      result.artifacts.some((artifact) => artifact.kind === "patch"),
      "a patch artifact should be captured"
    );
  } finally {
    cleanup();
  }
});

test("cursor adapter capabilities report supported when available", () => {
  const runner: CursorExecRunner = () => ({
    status: "succeeded",
    transcript: "ok",
    toolEvents: 0
  });
  const harness = cursorHarness({ runner, fusionBackendUrl: "http://x/v1" });
  const capabilities = harness.capabilities({} as EnsembleDescriptor);
  assert.equal(capabilities.apply_patch, "supported");
  assert.equal(capabilities.tool_call_loop, "supported");
  assert.equal(capabilities.adapter_available, "supported");
});
