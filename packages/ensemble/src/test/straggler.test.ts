import assert from "node:assert/strict";
import { test } from "node:test";

import { runEnsemble } from "../run.js";
import type {
  EnsembleDescriptor,
  HarnessAdapter,
  HarnessCandidateOutput
} from "../harness.js";

const BASE = {
  id: "straggler_test",
  models: [
    { id: "fast", model: "fake-fast" },
    { id: "stuck", model: "fake-stuck" }
  ],
  runtime: { id: "local" },
  judge: { id: "judge", model: "fake-judge" },
  prompt: "Do the task.",
  sourceRepo: "handoffkit",
  baseGitSha: "a".repeat(40)
};

/**
 * A harness whose ordinal-0 candidate succeeds immediately while every other
 * candidate hangs until its run signal aborts (modeling a stuck codex child
 * that only stops when killed).
 */
function stragglerHarness(): HarnessAdapter {
  return {
    id: "straggler-harness",
    prepare: () => ({}),
    collectArtifacts: () => [],
    cleanup: () => undefined,
    verificationProfile: () => ({ id: "straggler-verification", requiredEvidence: [] }),
    capabilities: () => ({}),
    run: async ({ model, ordinal, signal }): Promise<HarnessCandidateOutput> => {
      if (ordinal === 0) {
        return {
          candidateId: `straggler_test_${model.id}_${ordinal}`,
          model,
          status: "succeeded",
          transcript: "done",
          summary: "done"
        };
      }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const reason: unknown = signal?.reason;
      return {
        candidateId: `straggler_test_${model.id}_${ordinal}`,
        model,
        status: "failed",
        endReason: {
          kind: "aborted",
          detail: reason instanceof Error ? reason.message : String(reason ?? "aborted")
        },
        transcript: "killed",
        summary: "killed"
      };
    }
  };
}

function descriptor(overrides: Partial<EnsembleDescriptor> = {}): EnsembleDescriptor {
  return {
    ...BASE,
    harness: stragglerHarness(),
    policy: {
      id: "policy",
      allowedTools: ["read_file"],
      sideEffects: "read_only" as const
    },
    ...overrides
  };
}

test("straggler grace window drops a stuck candidate instead of failing the run", async () => {
  const result = await runEnsemble(
    descriptor({
      policy: {
        id: "policy",
        allowedTools: ["read_file"],
        sideEffects: "read_only" as const,
        stragglerGraceMs: 50
      }
    })
  );
  const statuses = result.candidates.map((candidate) => candidate.status);
  assert.deepEqual(statuses, ["succeeded", "failed"]);
  assert.equal(
    result.harnessRunResult.status,
    "succeeded",
    "an abandoned straggler must not fail the run — the survivor is the result"
  );
});

test("a pre-aborted descriptor signal cancels every candidate", async () => {
  const result = await runEnsemble(
    descriptor({ signal: AbortSignal.abort(new Error("panel cancelled")) })
  );
  // Ordinal 0 returns success synchronously (it never checks the signal);
  // the hanging candidate resolves immediately from the pre-aborted signal.
  const statuses = result.candidates.map((candidate) => candidate.status);
  assert.deepEqual(statuses, ["succeeded", "failed"]);
});

test("without a grace window every candidate is awaited (legacy behavior)", async () => {
  let resolveSlow: (() => void) | undefined;
  const slowDone = new Promise<void>((resolve) => {
    resolveSlow = resolve;
  });
  const harness: HarnessAdapter = {
    ...stragglerHarness(),
    run: async ({ model, ordinal }): Promise<HarnessCandidateOutput> => {
      if (ordinal === 1) await slowDone;
      return {
        candidateId: `straggler_test_${model.id}_${ordinal}`,
        model,
        status: "succeeded",
        transcript: "done",
        summary: "done"
      };
    }
  };
  const run = runEnsemble(descriptor({ harness }));
  // Give the fast candidate time to settle; the run must still be pending.
  await new Promise((resolve) => setTimeout(resolve, 100));
  let settled = false;
  void run.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "no grace window means the run waits for the slow candidate");
  resolveSlow?.();
  const result = await run;
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.status),
    ["succeeded", "succeeded"]
  );
});
