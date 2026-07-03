import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockDriver } from "@fusionkit/harness-core/testing";
import type { ResumeCursor } from "@fusionkit/harness-core";

import { createDriverHarness } from "../driver-adapter.js";
import { ensemble } from "../run.js";
import type { EnsembleDescriptor } from "../harness.js";

function tempOutputRoot(): { outputRoot: string; cleanup: () => void } {
  const outputRoot = mkdtempSync(join(tmpdir(), "driver-adapter-out-"));
  return { outputRoot, cleanup: () => rmSync(outputRoot, { recursive: true, force: true }) };
}

function descriptor(outputRoot: string, harness: EnsembleDescriptor["harness"]): EnsembleDescriptor {
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
    baseGitSha: "c".repeat(40),
    outputRoot
  };
}

test("driver bridge runs a panel candidate through a harness-core driver", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const driver = createMockDriver();
  const harness = createDriverHarness({
    driver,
    config: driver.configSchema.parse({ replies: ["fused answer"] })
  });
  try {
    const result = await ensemble.run(descriptor(outputRoot, harness));
    assert.equal(result.harnessRunResult.status, "succeeded");
    const candidate = result.candidates[0];
    assert.equal(candidate?.status, "succeeded");
    assert.equal(candidate?.harness_kind, "generic");
  } finally {
    cleanup();
  }
});

test("driver bridge threads resume cursors across turns", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const driver = createMockDriver();
  const resumeCursors = new Map<string, ResumeCursor>();
  const harness = createDriverHarness({
    driver,
    config: driver.configSchema.parse({ replies: ["turn one", "turn two"] }),
    resumeCursors
  });
  try {
    await ensemble.run(descriptor(outputRoot, harness));
    const first = [...resumeCursors.values()][0];
    assert.ok(first, "a resume cursor was captured after the turn");
    assert.equal(first.kind, "generic");
    assert.ok((first.data as { sessionId?: string }).sessionId);
  } finally {
    cleanup();
  }
});
