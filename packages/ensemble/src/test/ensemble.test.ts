import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertJudgeSynthesisRecordV1,
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  requestHash,
  responseHash
} from "@fusionkit/protocol";
import type { ModelCallRecordV1 } from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";

import { createCommandHarness } from "../command.js";
import { createMockJudgeSynthesizer } from "../judge.js";
import { createMockHarness } from "../mock.js";
import { runEnsemble } from "../run.js";
import type {
  CandidateContainerDriver,
  CandidateHardeningMetadata,
  CandidateMicrovmDriver,
  EnsembleDescriptor,
  HarnessAdapter
} from "../harness.js";

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

function modelCallRecord(callId: string, model = "fake-fast"): ModelCallRecordV1 {
  return {
    schema: "model-call-record.v1",
    schema_version: "v1",
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "ensemble-test",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: "2026-06-16T00:00:00.000Z",
    call_id: callId,
    endpoint_id: "test-endpoint",
    model,
    request_hash: requestHash({ prompt: "test" }),
    response_hash: responseHash({ output: "ok" }),
    messages: [{ role: "user", content: requestHash("test") }],
    status: "succeeded",
    side_effects: "none",
    started_at: "2026-06-16T00:00:00.000Z",
    finished_at: "2026-06-16T00:00:00.010Z",
    latency_ms: 10,
    metadata: { unknown_usage: true, unknown_cost: true }
  };
}

function makeRepo(): { repo: string; cleanup: () => void; head: string; outputRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "ensemble-repo-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitText(repo, ["init", "--quiet", "--initial-branch=main"]);
  gitText(repo, ["config", "user.email", "ensemble@warrant.local"]);
  gitText(repo, ["config", "user.name", "ensemble"]);
  writeFileSync(join(repo, "README.md"), "# ensemble\n");
  gitText(repo, ["add", "-A"]);
  gitText(repo, ["commit", "--quiet", "-m", "init"]);
  return {
    repo,
    outputRoot: join(root, "out"),
    head: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function addFilePatch(path: string, content: string): string {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ""
  ].join("\n");
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
  assert.deepEqual(result.summary?.candidates[0]?.toolExecutionIds, [
    "exec_ensemble_test_command_0"
  ]);
});

test("command adapter records optional container hardening metadata", async () => {
  const driver: CandidateContainerDriver = {
    id: "fake-ensemble-container",
    supportsNetworkPolicy: true,
    execute(input) {
      assert.equal(input.image, "node:22-hardening");
      return {
        stdout: "container-hardening",
        stderr: "",
        exitCode: 0,
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "command", model: "local-shell" }],
      runtime: {
        id: "local",
        isolation: {
          kind: "container",
          image: "node:22-hardening",
          driver,
          mountPolicy: { readOnlyCachePaths: ["/tmp/cache"] },
          networkPolicy: { defaultDeny: true, allowHosts: [], enforce: true },
          secretPolicy: {
            secretNames: ["API_TOKEN"],
            secretValueHashes: ["sha256:" + "b".repeat(64)],
            injectedEnvNames: ["API_TOKEN"]
          }
        }
      },
      harness: createCommandHarness({
        command: "printf container-hardening"
      })
    })
  );

  const metadata = result.candidates[0]?.metadata as
    | { hardening?: CandidateHardeningMetadata }
    | undefined;
  assert.equal(metadata?.hardening?.requested_isolation, "container");
  assert.equal(metadata?.hardening?.runtime.image, "node:22-hardening");
  assert.equal(metadata?.hardening?.mount_policy.read_only_caches[0], "/tmp/cache");
  assert.equal(metadata?.hardening?.cleanup.status, "succeeded");
  assert.equal(metadata?.hardening?.secret_absence.secret_names[0], "API_TOKEN");
  assert.equal(result.summary?.candidates[0]?.hardening?.actual_isolation, "container");
  assert.equal(
    (result.harnessRunRequest.metadata?.hardening as { requested_isolation?: string })
      .requested_isolation,
    "container"
  );
  assert.equal(
    (result.harnessRunResult.metadata?.hardening as { cleanup_succeeded?: number })
      .cleanup_succeeded,
    1
  );
});

test("command adapter records optional microVM hardening metadata", async () => {
  const driver: CandidateMicrovmDriver = {
    id: "fake-ensemble-microvm",
    provider: "vercel-sandbox",
    supportsNetworkPolicy: true,
    execute(input) {
      assert.equal(input.provider, "vercel-sandbox");
      assert.equal(input.runtime, "node24");
      assert.equal(input.snapshotId, "snap_ensemble");
      return {
        stdout: "microvm-hardening",
        stderr: "",
        exitCode: 0,
        actualIsolation: "vercel-sandbox",
        runtime: {
          provider: "vercel-sandbox",
          runtime: "node24",
          snapshotId: "snap_ensemble",
          sandboxId: "sbx_ensemble",
          runtimeDigest: "sha256:" + "d".repeat(64)
        },
        cleanup: { attempted: true, succeeded: true }
      };
    }
  };
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "command", model: "local-shell" }],
      runtime: {
        id: "local",
        isolation: {
          kind: "microvm",
          provider: "vercel-sandbox",
          runtime: "node24",
          snapshotId: "snap_ensemble",
          driver,
          networkPolicy: { defaultDeny: true, allowHosts: [], enforce: true },
          secretPolicy: {
            secretNames: ["VERCEL_TOKEN"],
            secretValueHashes: ["sha256:" + "e".repeat(64)],
            injectedEnvNames: ["VERCEL_TOKEN"]
          }
        }
      },
      harness: createCommandHarness({
        command: "printf microvm-hardening"
      })
    })
  );

  const metadata = result.candidates[0]?.metadata as
    | { hardening?: CandidateHardeningMetadata }
    | undefined;
  assert.equal(metadata?.hardening?.requested_isolation, "microvm");
  assert.equal(metadata?.hardening?.actual_isolation, "vercel-sandbox");
  assert.equal(metadata?.hardening?.runtime.provider, "vercel-sandbox");
  assert.equal(metadata?.hardening?.runtime.snapshot_id, "snap_ensemble");
  assert.equal(metadata?.hardening?.runtime.sandbox_id, "sbx_ensemble");
  assert.equal(metadata?.hardening?.runtime.driver, "fake-ensemble-microvm");
  assert.equal(metadata?.hardening?.cleanup.status, "succeeded");
  assert.equal(result.summary?.candidates[0]?.hardening?.actual_isolation, "vercel-sandbox");
  assert.equal(
    (result.harnessRunRequest.metadata?.hardening as { requested_isolation?: string })
      .requested_isolation,
    "microvm"
  );
  assert.equal(
    (result.harnessRunResult.metadata?.hardening as { cleanup_succeeded?: number })
      .cleanup_succeeded,
    1
  );
});

test("mock adapter preserves optional container request as process fallback metadata", async () => {
  const result = await runEnsemble(
    descriptor({
      runtime: {
        id: "local",
        isolation: {
          kind: "container",
          image: "node:22-hardening",
          networkPolicy: { defaultDeny: true, allowHosts: [], enforce: true }
        }
      }
    })
  );

  const metadata = result.candidates[0]?.metadata as
    | { hardening?: CandidateHardeningMetadata }
    | undefined;
  assert.equal(metadata?.hardening?.requested_isolation, "container");
  assert.equal(metadata?.hardening?.actual_isolation, "process");
  assert.equal(metadata?.hardening?.cleanup.status, "not_required");
  assert.equal(metadata?.hardening?.network_policy.enforced, false);
  assert.equal(result.summary?.candidates[0]?.hardening?.requested_isolation, "container");
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
  assert.equal(Object.isFrozen(result.candidates[0]?.artifacts), true);
  assert.equal(Object.isFrozen(result.artifacts[0]), true);
  assert.throws(() => {
    (result.candidates as unknown as unknown[]).push({});
  });
  assert.throws(() => {
    (result.candidates[0]?.artifacts as unknown as unknown[]).push({});
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

test("adapter-provided model call records link candidates and summary metadata", async () => {
  const record = modelCallRecord("model_call_fast");
  const result = await runEnsemble(
    descriptor({
      models: [{ id: "fast", model: "fake-fast" }],
      harness: createMockHarness({
        candidates: {
          fast: { modelCallRecord: record }
        }
      })
    })
  );

  assert.equal(result.candidates[0]?.model_call_id, "model_call_fast");
  assert.equal(result.modelCallRecords.length, 1);
  assert.equal(result.modelCallRecords[0]?.call_id, "model_call_fast");
  assert.equal(result.summary?.modelCallRecords.length, 1);
  assert.equal(result.summary?.candidates[0]?.modelCallId, "model_call_fast");
  assert.ok(result.artifacts.some((artifact) => artifact.artifact_id.includes("model_call_record")));
});

test("candidate worktrees are created from one snapshot and summarized after cleanup", async () => {
  const repo = makeRepo();
  try {
    const harness = createMockHarness({
      candidates: {
        fast: { transcript: "fast transcript", summary: "fast summary" },
        writer: { transcript: "writer transcript", summary: "writer summary" }
      }
    });
    const result = await runEnsemble(
      descriptor({
        harness,
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        cleanupWorktrees: true
      })
    );

    assert.equal(result.candidates.length, 2);
    assert.equal(result.summary?.snapshot?.baseGitSha, repo.head);
    assert.equal(result.summary?.candidates.length, 2);
    assert.ok(result.summaryPath);
    assert.equal(existsSync(result.summaryPath), true);

    for (const candidate of result.candidates) {
      assert.ok(candidate.branch_name);
      assert.ok(candidate.worktree_path);
      assert.equal(existsSync(candidate.worktree_path), false);
      assert.ok(candidate.artifacts?.some((artifact) => artifact.kind === "worktree"));
      assert.ok(candidate.artifacts?.some((artifact) => artifact.kind === "transcript"));
    }

    const summary = JSON.parse(readFileSync(result.summaryPath, "utf8")) as {
      candidates: { worktreePath?: string; diffArtifacts: unknown[] }[];
      finalPatchPath: string | null;
    };
    assert.equal(summary.finalPatchPath, null);
    assert.equal(summary.candidates.length, 2);
    assert.ok(summary.candidates.every((candidate) => candidate.worktreePath));
  } finally {
    repo.cleanup();
  }
});

test("candidate worktree diffs become patch artifacts", async () => {
  const repo = makeRepo();
  try {
    const harness: HarnessAdapter = {
      id: "worktree-writer",
      prepare: () => undefined,
      capabilities: () => ({ workspace_write: "supported" }),
      verificationProfile: () => ({
        id: "worktree-writer",
        requiredEvidence: ["patch", "worktree"]
      }),
      collectArtifacts: () => [],
      run: ({ model, worktree }) => {
        assert.ok(worktree);
        writeFileSync(join(worktree.path, `${model.id}.txt`), `${model.model}\n`);
        return {
          model,
          status: "succeeded",
          transcript: `${model.id} wrote a file`,
          verification: { status: "succeeded", evidence: ["file written"], exitCode: 0 }
        };
      }
    };

    const result = await runEnsemble(
      descriptor({
        harness,
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot
      })
    );

    assert.equal(result.candidates.length, 2);
    assert.ok(
      result.candidates.every((candidate) =>
        candidate.artifacts?.some((artifact) => artifact.kind === "patch")
      )
    );
    assert.ok(
      result.summary?.candidates.every((candidate) => candidate.diffArtifacts.length === 1)
    );
  } finally {
    repo.cleanup();
  }
});

test("adapter cleanup runs when collection fails", async () => {
  let cleaned = false;
  const harness: HarnessAdapter = {
    id: "cleanup",
    prepare: () => undefined,
    capabilities: () => ({ cleanup: "supported" }),
    verificationProfile: () => ({ id: "cleanup", requiredEvidence: [] }),
    run: ({ model }) => ({ model, status: "succeeded" }),
    collectArtifacts: () => {
      throw new Error("boom");
    },
    cleanup: () => {
      cleaned = true;
    }
  };

  await assert.rejects(() => runEnsemble(descriptor({ harness })), /boom/);
  assert.equal(cleaned, true);
});

test("judge synthesis creates a final patch artifact from the original base", async () => {
  const repo = makeRepo();
  try {
    const result = await runEnsemble(
      descriptor({
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        judge: {
          id: "judge",
          synthesizer: createMockJudgeSynthesizer({
            output: {
              decision: "synthesize",
              finalOutput: "final patch",
              rationale: "combine candidate evidence",
              patch: {
                content: addFilePatch("final.txt", "final\n"),
                sourceCandidateIds: ["ensemble_test_fast_0"],
                author: "judge"
              },
              contributions: [{ candidateId: "ensemble_test_fast_0", reason: "used evidence" }],
              rejections: [{ candidateId: "ensemble_test_writer_1", reason: "less complete" }]
            },
            verificationResults: [
              { status: "succeeded", evidence: ["final tests passed"], exitCode: 0 }
            ]
          })
        }
      })
    );

    assert.ok(result.judgeSynthesisRecord);
    assertJudgeSynthesisRecordV1(result.judgeSynthesisRecord);
    assert.equal(result.judgeSynthesisRecord.decision, "synthesize");
    assert.ok(result.finalPatchPath);
    assert.equal(result.summary?.finalPatchPath, result.finalPatchPath);
    const finalPatchArtifact = result.artifacts.find((artifact) =>
      artifact.artifact_id.endsWith("_final_patch")
    );
    assert.ok(finalPatchArtifact?.uri);
    const finalPatch = readFileSync(new URL(finalPatchArtifact.uri), "utf8");
    assert.ok(finalPatch.includes("final.txt"));
    assert.ok(!finalPatch.includes("fast.txt"), "candidate worktree output is not the base");
  } finally {
    repo.cleanup();
  }
});

test("judge synthesis patch conflicts produce conflict artifacts", async () => {
  const repo = makeRepo();
  try {
    const result = await runEnsemble(
      descriptor({
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        judge: {
          id: "judge",
          synthesizer: createMockJudgeSynthesizer({
            output: {
              decision: "synthesize",
              finalOutput: "bad patch",
              patch: {
                content: "this is not a patch",
                sourceCandidateIds: ["ensemble_test_fast_0"]
              }
            }
          })
        }
      })
    );

    assert.equal(result.judgeSynthesisRecord?.status, "failed");
    assert.equal(result.judgeSynthesisRecord?.decision, "failed");
    assert.equal(result.failureSummary?.reason, "patch_conflict");
    assert.ok(result.artifacts.some((artifact) => artifact.artifact_id.includes("patch_conflict")));
  } finally {
    repo.cleanup();
  }
});

test("judge synthesis performs one repair round and records success", async () => {
  const repo = makeRepo();
  try {
    const result = await runEnsemble(
      descriptor({
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        judge: {
          id: "judge",
          synthesizer: createMockJudgeSynthesizer({
            output: {
              decision: "synthesize",
              finalOutput: "needs repair",
              patch: { content: addFilePatch("initial.txt", "initial\n") }
            },
            repairOutput: {
              decision: "synthesize",
              finalOutput: "repaired",
              patch: { content: addFilePatch("repair.txt", "repair\n") }
            },
            verificationResults: [
              { status: "failed", evidence: ["initial failed"], exitCode: 1 },
              { status: "succeeded", evidence: ["repair passed"], exitCode: 0 }
            ]
          })
        }
      })
    );

    assert.equal(result.repairAttempts?.length, 1);
    assert.equal(result.repairAttempts?.[0]?.status, "succeeded");
    assert.equal(result.judgeSynthesisRecord?.status, "succeeded");
    assert.equal(result.failureSummary, undefined);
  } finally {
    repo.cleanup();
  }
});

test("failed repair returns failure summary without deterministic fallback winner", async () => {
  const repo = makeRepo();
  try {
    const result = await runEnsemble(
      descriptor({
        workspace: repo.repo,
        baseGitSha: repo.head,
        outputRoot: repo.outputRoot,
        reviewEvidence: {
          strategy: "tests-pass-smallest-diff",
          scorecards: [{ candidate_id: "ensemble_test_fast_0", diffBytes: 1 }],
          reason: "evidence only"
        },
        judge: {
          id: "judge",
          synthesizer: createMockJudgeSynthesizer({
            output: {
              decision: "synthesize",
              finalOutput: "needs repair",
              patch: { content: addFilePatch("initial.txt", "initial\n") }
            },
            repairOutput: {
              decision: "synthesize",
              finalOutput: "still broken",
              patch: { content: addFilePatch("repair.txt", "repair\n") }
            },
            verificationResults: [
              { status: "failed", evidence: ["initial failed"], exitCode: 1 },
              { status: "failed", evidence: ["repair failed"], exitCode: 1 }
            ]
          })
        }
      })
    );

    assert.equal(result.judgeSynthesisRecord?.status, "failed");
    assert.equal(result.judgeSynthesisRecord?.decision, "repair_required");
    assert.equal(result.failureSummary?.reason, "repair_failed");
    assert.equal("chosen" in result, false);
    assert.equal(result.judgeSynthesisRecord.selected_trajectory_id, undefined);
  } finally {
    repo.cleanup();
  }
});
