import {
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  requestHash
} from "@warrant/protocol";
import type {
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JsonValue,
  ModelCallRecordV1,
  ModelFusionStatus
} from "@warrant/protocol";

import { createArtifactStore } from "./artifacts.js";
import type {
  CandidateHardeningMetadata,
  EnsembleCandidateSummary,
  EnsembleDescriptor,
  EnsembleRunResult,
  EnsembleRunSummary,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessToolRecord
} from "./harness.js";
import { runJudgeSynthesis } from "./synthesis.js";
import {
  cleanupWorktreePlan,
  createWorktreePlan,
  defaultOutputRoot,
  diffCandidateWorktree,
  sealCandidateWorktree
} from "./worktree.js";

type StoredHarnessArtifact = HarnessArtifact & { path?: string };

const SCHEMA_BUNDLE_HASH =
  "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3";
const PRODUCER_GIT_SHA = "0".repeat(40);
const PRODUCER = "handoffkit-ensemble";
const PRODUCER_VERSION = "0.1.0";

type ContractMetadataInput<S extends string> = {
  schema: S;
  createdAt: string;
};

function metadata<S extends string>(input: ContractMetadataInput<S>) {
  return {
    schema: input.schema,
    schema_version: "v1" as const,
    schema_bundle_hash: SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: input.createdAt
  };
}

function terminalStatus(outputs: readonly HarnessCandidateOutput[]): ModelFusionStatus {
  if (outputs.some((output) => output.status === "failed")) return "failed";
  if (outputs.some((output) => output.status === "requires_action")) return "requires_action";
  if (outputs.every((output) => output.status === "skipped")) return "skipped";
  return "succeeded";
}

function assertDescriptor(descriptor: EnsembleDescriptor): void {
  if ("checks" in descriptor && descriptor.checks !== undefined) {
    throw new Error("ensemble descriptors do not accept ad hoc checks");
  }
  if (!descriptor.harness) throw new Error("ensemble descriptor requires one harness");
  if (!Array.isArray(descriptor.models) || descriptor.models.length === 0) {
    throw new Error("ensemble descriptor requires at least one model");
  }
  for (const model of descriptor.models) {
    if (!model.id || !model.model) {
      throw new Error("each ensemble model requires id and model");
    }
  }
  if (!descriptor.runtime?.id) throw new Error("ensemble descriptor requires one runtime");
  if (!descriptor.judge?.id) throw new Error("ensemble descriptor requires one judge");
  if (!descriptor.policy?.id) throw new Error("ensemble descriptor requires one policy");
}

function freezeResult(result: EnsembleRunResult): EnsembleRunResult {
  for (const candidate of result.candidates) {
    candidate.artifacts?.forEach((artifact) => Object.freeze(artifact));
    Object.freeze(candidate.artifacts ?? []);
    Object.freeze(candidate);
  }
  for (const artifact of result.artifacts) Object.freeze(artifact);
  for (const toolRecord of result.toolRecords) Object.freeze(toolRecord);
  for (const modelCallRecord of result.modelCallRecords) Object.freeze(modelCallRecord);
  if (result.harnessRunResult.artifacts) {
    for (const artifact of result.harnessRunResult.artifacts) Object.freeze(artifact);
    Object.freeze(result.harnessRunResult.artifacts);
  }
  Object.freeze(result.harnessRunResult);
  Object.freeze(result.harnessRunRequest);
  Object.freeze(result.summary?.candidates ?? []);
  Object.freeze(result.summary?.artifacts ?? []);
  if (result.summary) Object.freeze(result.summary);
  Object.freeze(result.candidates);
  Object.freeze(result.artifacts);
  Object.freeze(result.toolRecords);
  Object.freeze(result.modelCallRecords);
  return Object.freeze(result);
}

function candidateMetadata(
  output: HarnessCandidateOutput,
  descriptor: EnsembleDescriptor,
  worktree: { baseGitSha: string; snapshotHash: string } | undefined
): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = {
    model_id: output.model.id,
    model: output.model.model,
    endpoint_id: output.model.endpointId ?? output.model.id
  };
  if (output.verification !== undefined) {
    metadata.verification = output.verification;
  }
  if (output.summary !== undefined) {
    metadata.summary = output.summary;
  }
  if (worktree !== undefined) {
    metadata.base_git_sha = worktree.baseGitSha;
    metadata.snapshot_hash = worktree.snapshotHash;
  }
  Object.assign(metadata, output.metadata ?? {});
  if (metadata.hardening === undefined) {
    metadata.hardening = fallbackCandidateHardening(descriptor) as unknown as JsonValue;
  }
  if (descriptor.reviewEvidence !== undefined) {
    metadata.review_evidence_attached = true;
  }
  if (output.modelCallRecord !== undefined) {
    metadata.model_call_recorded = true;
  }
  return metadata;
}

function artifactsForOutput(input: {
  descriptor: EnsembleDescriptor;
  candidateId: string;
  output: HarnessCandidateOutput;
  patch: string;
  worktree?: { path: string; baseGitSha: string; snapshotHash: string };
  store: ReturnType<typeof createArtifactStore>;
}): StoredHarnessArtifact[] {
  const artifacts: StoredHarnessArtifact[] = [...(input.output.artifacts ?? [])];
  const prefix = `${input.descriptor.id}_${input.candidateId}`;
  if (input.patch.length > 0) {
    artifacts.push(
      input.store.writeText({
        artifactId: `${prefix}_patch`,
        kind: "patch",
        content: input.patch,
        suffix: ".patch"
      })
    );
  }
  if (input.output.transcript !== undefined) {
    artifacts.push(
      input.store.writeText({
        artifactId: `${prefix}_transcript`,
        kind: "transcript",
        content: input.output.transcript,
        suffix: ".txt"
      })
    );
  }
  if (input.output.log !== undefined) {
    artifacts.push(
      input.store.writeText({
        artifactId: `${prefix}_log`,
        kind: "log",
        content: input.output.log,
        suffix: ".log"
      })
    );
  }
  if (input.output.toolRecords && input.output.toolRecords.length > 0) {
    artifacts.push(
      input.store.writeJson({
        artifactId: `${prefix}_tool_journal`,
        kind: "other",
        value: input.output.toolRecords
      })
    );
  }
  if (input.output.verification !== undefined) {
    artifacts.push(
      input.store.writeJson({
        artifactId: `${prefix}_verification`,
        kind: "metrics",
        value: input.output.verification
      })
    );
  }
  if (input.output.modelCallRecord !== undefined) {
    artifacts.push(
      input.store.writeJson({
        artifactId: `${prefix}_model_call_record`,
        kind: "metrics",
        value: input.output.modelCallRecord
      })
    );
  }
  if (input.worktree !== undefined) {
    artifacts.push(
      input.store.writeJson({
        artifactId: `${prefix}_worktree`,
        kind: "worktree",
        value: {
          path: input.worktree.path,
          baseGitSha: input.worktree.baseGitSha,
          snapshotHash: input.worktree.snapshotHash
        }
      })
    );
  }
  artifacts.push(...(input.output.screenshots ?? []));
  return artifacts;
}

function artifactRef(artifact: StoredHarnessArtifact): HarnessArtifact {
  const { path: _path, ...ref } = artifact;
  return ref;
}

function outputSummary(outputs: readonly HarnessCandidateOutput[], harnessId: string): string {
  const counts = new Map<ModelFusionStatus, number>();
  for (const output of outputs) counts.set(output.status, (counts.get(output.status) ?? 0) + 1);
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  return `${outputs.length} candidate(s) produced by ${harnessId}; statuses ${countText}`;
}

function runtimeHardeningMetadata(descriptor: EnsembleDescriptor): Record<string, JsonValue> {
  const isolation = descriptor.runtime.isolation;
  return {
    requested_isolation: isolation?.kind ?? "process",
    runtime_id: descriptor.runtime.id,
    ...(descriptor.runtime.environmentId !== undefined
      ? { environment_id: descriptor.runtime.environmentId }
      : {}),
    ...(isolation?.kind === "container"
      ? {
          image: isolation.image ?? "node:22",
          engine: isolation.engine ?? "docker",
          driver: isolation.driver?.id ?? isolation.engine ?? "docker"
        }
      : {})
  };
}

function fallbackCandidateHardening(descriptor: EnsembleDescriptor): CandidateHardeningMetadata {
  const isolation = descriptor.runtime.isolation;
  const mountPolicy = isolation?.mountPolicy;
  const networkPolicy = isolation?.networkPolicy;
  const secretPolicy = isolation?.secretPolicy;
  return {
    requested_isolation: isolation?.kind ?? "process",
    actual_isolation: "process",
    runtime: {
      ...(isolation?.kind === "container" ? { image: isolation.image ?? "node:22" } : {}),
      workdir: mountPolicy?.workdir ?? "/workspace"
    },
    mount_policy: {
      worktree_writable: mountPolicy?.worktreeWritable ?? true,
      read_only_caches: [...(mountPolicy?.readOnlyCachePaths ?? [])],
      ignored_dirs: [...(mountPolicy?.ignoredDirs ?? [".git", "node_modules", ".warrant"])]
    },
    network_policy: {
      default_deny: networkPolicy?.defaultDeny ?? true,
      allow_hosts: [...(networkPolicy?.allowHosts ?? [])],
      enforced: false
    },
    cleanup: {
      attempted: false,
      succeeded: true,
      status: "not_required"
    },
    secret_absence: {
      secret_names: [...(secretPolicy?.secretNames ?? [])],
      secret_value_hashes: [...(secretPolicy?.secretValueHashes ?? [])],
      injected_env_names: [...(secretPolicy?.injectedEnvNames ?? [])],
      scanned: false,
      leaks_found: false,
      scan_scope: [],
      leak_count: 0
    }
  };
}

function candidateHardening(
  output: HarnessCandidateOutput | undefined,
  descriptor: EnsembleDescriptor
): CandidateHardeningMetadata | undefined {
  const hardening = output?.metadata?.hardening;
  if (typeof hardening === "object" && hardening !== null && !Array.isArray(hardening)) {
    return hardening as unknown as CandidateHardeningMetadata;
  }
  if (output !== undefined) return fallbackCandidateHardening(descriptor);
  return undefined;
}

export async function runEnsemble(descriptor: EnsembleDescriptor): Promise<EnsembleRunResult> {
  assertDescriptor(descriptor);
  const createdAt = new Date().toISOString();
  const capabilities = descriptor.harness.capabilities(descriptor);
  const outputRoot = defaultOutputRoot(descriptor);
  const store = createArtifactStore(`${outputRoot}/artifacts`);
  const worktreePlan = createWorktreePlan(descriptor);
  const request: HarnessRunRequestV1 = {
    ...metadata({ schema: "harness-run-request.v1", createdAt }),
    request_id: `ensemble_req_${descriptor.id}`,
    harness_kind: "generic",
    source_repo: descriptor.sourceRepo,
    base_git_sha: descriptor.baseGitSha,
    prompt: descriptor.prompt,
    prompt_hash: requestHash({
      prompt: descriptor.prompt,
      descriptor_id: descriptor.id
    }),
    allowed_tools: descriptor.policy.allowedTools,
    side_effects: descriptor.policy.sideEffects,
    requested_capabilities: capabilities,
    metadata: {
      harness_id: descriptor.harness.id,
      runtime_id: descriptor.runtime.id,
      judge_id: descriptor.judge.id,
      policy_id: descriptor.policy.id,
      hardening: runtimeHardeningMetadata(descriptor),
      output_root: outputRoot,
      ...(worktreePlan
        ? {
            snapshot_hash: worktreePlan.snapshotHash,
            snapshot_base_git_sha: worktreePlan.baseGitSha
          }
        : {}),
      ...(descriptor.metadata ?? {})
    }
  };
  assertHarnessRunRequestV1(request);

  let prepared: unknown;
  let outputs: HarnessCandidateOutput[] = [];
  let cleanupWorktrees = worktreePlan?.worktrees ?? [];
  try {
    prepared = await descriptor.harness.prepare({ descriptor, request });
    outputs = await Promise.all(
      descriptor.models.map((model, ordinal) =>
        descriptor.harness.run({
          descriptor,
          request,
          model,
          ordinal,
          prepared,
          worktree: worktreePlan?.worktrees[ordinal]
        })
      )
    );
    const collectedArtifacts = await descriptor.harness.collectArtifacts({
      descriptor,
      request,
      candidates: outputs,
      prepared
    });
    const verification = descriptor.harness.verificationProfile(descriptor);

    const generatedArtifacts = new Map<string, StoredHarnessArtifact[]>();
    const sealedWorktrees = worktreePlan?.worktrees.map((worktree) => sealCandidateWorktree(worktree));
    cleanupWorktrees = sealedWorktrees ?? cleanupWorktrees;
    for (const [ordinal, output] of outputs.entries()) {
      const worktree = sealedWorktrees?.[ordinal];
      const id = output.candidateId ?? worktree?.candidateId ?? `${descriptor.id}_${output.model.id}_${ordinal}`;
      const patch = worktree ? diffCandidateWorktree(worktree) : (output.diff ?? "");
      generatedArtifacts.set(
        id,
        artifactsForOutput({
          descriptor,
          candidateId: id,
          output,
          patch,
          ...(worktree ? { worktree } : {}),
          store
        })
      );
    }

    const modelCallRecords: ModelCallRecordV1[] = outputs.flatMap((output) =>
      output.modelCallRecord ? [output.modelCallRecord] : []
    );

    const candidates: HarnessCandidateRecordV1[] = outputs.map((output, ordinal) => {
      const worktree = sealedWorktrees?.[ordinal];
      const id =
        output.candidateId ??
        worktree?.candidateId ??
        `${descriptor.id}_${output.model.id}_${ordinal}`;
      const artifacts = (generatedArtifacts.get(id) ?? output.artifacts ?? []).map(artifactRef);
      const record: HarnessCandidateRecordV1 = {
        ...metadata({ schema: "harness-candidate-record.v1", createdAt }),
        candidate_id: id,
        request_id: request.request_id,
        harness_kind: "generic",
        model_call_id: output.modelCallId ?? output.modelCallRecord?.call_id ?? `${id}_model_call`,
        status: output.status,
        side_effects: descriptor.policy.sideEffects,
        artifacts,
        ...(output.branchName ?? worktree?.branchName
          ? { branch_name: output.branchName ?? worktree?.branchName }
          : {}),
        ...(output.worktreePath ?? worktree?.path
          ? { worktree_path: output.worktreePath ?? worktree?.path }
          : {}),
        ...(output.score !== undefined ? { score: output.score } : {}),
        ...(output.error ? { error: output.error } : {}),
        metadata: candidateMetadata(output, descriptor, worktree)
      };
      assertHarnessCandidateRecordV1(record);
      return record;
    });

    const baseArtifacts: HarnessArtifact[] = [
      ...collectedArtifacts,
      ...candidates.flatMap((candidate) => candidate.artifacts ?? [])
    ];
    const toolRecords: HarnessToolRecord[] = outputs.flatMap((output) => output.toolRecords ?? []);
    const synthesis = await runJudgeSynthesis({
      descriptor,
      candidates,
      outputs,
      artifacts: baseArtifacts,
      toolRecords,
      modelCallRecords,
      ...(descriptor.reviewEvidence ? { reviewEvidence: descriptor.reviewEvidence } : {}),
      ...(worktreePlan?.workspace ? { workspace: worktreePlan.workspace } : {}),
      ...(worktreePlan?.baseGitSha ? { baseGitSha: worktreePlan.baseGitSha } : {}),
      store
    });
    const artifacts: HarnessArtifact[] = [
      ...baseArtifacts,
      ...(synthesis?.artifacts ?? [])
    ];
    const summary: EnsembleRunSummary = {
      descriptorId: descriptor.id,
      ...(worktreePlan
        ? {
            snapshot: {
              baseGitSha: worktreePlan.baseGitSha,
              snapshotHash: worktreePlan.snapshotHash,
              workspace: worktreePlan.workspace
            }
          }
        : {}),
      candidates: candidates.map((candidate, ordinal): EnsembleCandidateSummary => {
        const output = outputs[ordinal];
        const diffArtifacts = (candidate.artifacts ?? []).filter(
          (artifact) => artifact.kind === "patch"
        );
        return {
          candidateId: candidate.candidate_id,
          modelId: output?.model.id ?? "",
          model: output?.model.model ?? "",
          ...(candidate.model_call_id ? { modelCallId: candidate.model_call_id } : {}),
          status: candidate.status,
          ...(candidate.branch_name ? { branchName: candidate.branch_name } : {}),
          ...(candidate.worktree_path ? { worktreePath: candidate.worktree_path } : {}),
          toolExecutionIds: output?.toolRecords?.map((record) => record.execution_id) ?? [],
          diffArtifacts,
          ...(output?.verification ? { verification: output.verification } : {}),
          ...(candidateHardening(output, descriptor)
            ? { hardening: candidateHardening(output, descriptor) }
            : {})
        };
      }),
      artifacts,
      modelCallRecords,
      ...(synthesis?.judgeSynthesisRecord
        ? { judgeSynthesisRecord: synthesis.judgeSynthesisRecord }
        : {}),
      finalPatchPath: synthesis?.finalPatchPath ?? null,
      ...(synthesis?.repairAttempts ? { repairAttempts: synthesis.repairAttempts } : {}),
      ...(synthesis?.failureSummary ? { failureSummary: synthesis.failureSummary } : {})
    };
    const summaryArtifact = store.writeJson({
      artifactId: `${descriptor.id}_summary`,
      kind: "metrics",
      value: summary
    });
    const summaryPath = summaryArtifact.path;
    const summaryArtifactRef = artifactRef(summaryArtifact);
    const result: HarnessRunResultV1 = {
      ...metadata({ schema: "harness-run-result.v1", createdAt }),
      result_id: `ensemble_result_${descriptor.id}`,
      request_id: request.request_id,
      harness_kind: "generic",
      status: terminalStatus(outputs),
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      output_summary: outputSummary(outputs, descriptor.harness.id),
      artifacts: [...artifacts, summaryArtifactRef],
      capabilities,
      started_at: createdAt,
      finished_at: new Date().toISOString(),
      metadata: {
        descriptor_id: descriptor.id,
        summary_path: summaryPath,
        hardening: {
          requested_isolation: descriptor.runtime.isolation?.kind ?? "process",
          candidate_count: candidates.length,
          cleanup_succeeded: outputs.filter(
            (output) => candidateHardening(output, descriptor)?.cleanup.succeeded === true
          ).length,
          cleanup_failed: outputs.filter(
            (output) => candidateHardening(output, descriptor)?.cleanup.status === "failed"
          ).length
        },
        ...(descriptor.reviewEvidence !== undefined
          ? { review_evidence: descriptor.reviewEvidence }
          : {})
      }
    };
    assertHarnessRunResultV1(result);

    return freezeResult({
      descriptorId: descriptor.id,
      harnessRunRequest: request,
      harnessRunResult: result,
      candidates,
      artifacts: [...artifacts, summaryArtifactRef],
      toolRecords,
      modelCallRecords,
      verification,
      summaryPath,
      summary,
      ...(synthesis?.judgeSynthesisRecord
        ? { judgeSynthesisRecord: synthesis.judgeSynthesisRecord }
        : {}),
      ...(synthesis ? { finalPatchPath: synthesis.finalPatchPath } : {}),
      ...(synthesis?.repairAttempts ? { repairAttempts: synthesis.repairAttempts } : {}),
      ...(synthesis?.failureSummary ? { failureSummary: synthesis.failureSummary } : {}),
      ...(descriptor.reviewEvidence ? { reviewEvidence: descriptor.reviewEvidence } : {})
    });
  } finally {
    await descriptor.harness.cleanup?.({
      descriptor,
      request,
      candidates: outputs,
      prepared
    });
    if (worktreePlan && descriptor.cleanupWorktrees === true) {
      cleanupWorktrees = cleanupWorktreePlan({
        ...worktreePlan,
        worktrees: cleanupWorktrees
      });
    }
  }
}

export const ensemble = {
  run: runEnsemble
} as const;
