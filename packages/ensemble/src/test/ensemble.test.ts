import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1
} from "@warrant/protocol";

import { createCommandHarness } from "../command.js";
import { createMockHarness } from "../mock.js";
import { runEnsemble } from "../run.js";
import type { EnsembleDescriptor } from "../harness.js";

const BASE_DESCRIPTOR = {
  id: "ensemble_test",
  models: [
    { id: "fast", model: "fake-fast" },
    { id: "writer", model: "fake-writer" }
  ],
  runtime: { id: "local" },
  judge: { id: "judge", model: "fake-judge" },
  policy: {
    id: "policy",
    allowedTools: ["read_file"],
    sideEffects: "read_only" as const,
    timeoutMs: 1_000
  },
  prompt: "Summarize model-fusion evidence.",
  sourceRepo: "handoffkit",
  baseGitSha: "a".repeat(40)
};

function descriptor(
  overrides: Partial<EnsembleDescriptor> = {}
): EnsembleDescriptor {
  return {
    ...BASE_DESCRIPTOR,
    harness: createMockHarness(),
    ...overrides
  };
}

test("mock adapter runs N candidates and emits valid model-fusion records", async () => {
  const result = await runEnsemble(
    descriptor({
      harness: createMockHarness({
        candidates: {
          writer: { score: 0.8, transcript: "writer transcript" }
        }
      })
    })
  );

  assert.equal(result.candidates.length, 2);
  assertHarnessRunRequestV1(result.harnessRunRequest);
  assertHarnessRunResultV1(result.harnessRunResult);
  for (const candidate of result.candidates) {
    assertHarnessCandidateRecordV1(candidate);
    assert.equal(candidate.status, "succeeded");
  }
  assert.equal(result.harnessRunResult.status, "succeeded");
  assert.ok(result.artifacts.length >= 4);
});

test("command adapter records command output, artifact, tool record, and verification", async () => {
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "command", model: "local-shell" }],
      harness: createCommandHarness({
        command: "printf command-ok"
      })
    })
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.harnessRunResult.status, "succeeded");
  assert.equal(result.toolRecords.length, 1);
  assert.equal(result.toolRecords[0]?.status, "succeeded");
  assert.equal(result.artifacts[0]?.kind, "log");
  const metadata = result.candidates[0]?.metadata as
    | { verification?: { status?: string } }
    | undefined;
  assert.equal(metadata?.verification?.status, "succeeded");
});

test("command adapter maps non-zero exit to failed protocol status", async () => {
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "command", model: "local-shell" }],
      harness: createCommandHarness({
        command: "exit 7"
      })
    })
  );

  assert.equal(result.harnessRunResult.status, "failed");
  assert.equal(result.candidates[0]?.status, "failed");
  assert.equal(result.toolRecords[0]?.status, "failed");
});

test("descriptor rejects zero models and ad hoc checks", async () => {
  await assert.rejects(
    () => runEnsemble(descriptor({ models: [] })),
    /at least one model/
  );
  await assert.rejects(
    () =>
      runEnsemble({
        ...descriptor(),
        checks: ["npm test"] as never
      }),
    /ad hoc checks/
  );
});

test("terminal candidate records and result arrays are immutable", async () => {
  const result = await runEnsemble(descriptor());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.throws(() => {
    (result.candidates as unknown as unknown[]).push({});
  });
});

test("review evidence is attached but never becomes final selection", async () => {
  const reviewEvidence = {
    strategy: "smallest-diff",
    scorecards: [{ candidate_id: "fast", diffBytes: 10 }],
    reason: "deterministic evidence only"
  };

  const result = await runEnsemble(descriptor({ reviewEvidence }));

  assert.deepEqual(result.reviewEvidence, reviewEvidence);
  assert.equal("chosen" in result, false);
  assert.equal("selected_candidate_id" in result.harnessRunResult, false);
});
