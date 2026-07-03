import {
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  requestHash
} from "@fusionkit/protocol";
import type {
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JsonValue,
  ModelCallRecordV1,
  ModelFusionStatus
} from "@fusionkit/protocol";

import { createArtifactStore } from "./artifacts.js";
import { hardeningToJson } from "./harness.js";
import { PRODUCER, PRODUCER_GIT_SHA, PRODUCER_VERSION } from "./provenance.js";
import type {
  CandidateHardeningMetadata,
  EnsembleCandidateSummary,
  EnsembleDescriptor,
  EnsembleModel,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_CONTAINER_IMAGE = "node:22";
const DEFAULT_CONTAINER_ENGINE = "docker";
const DEFAULT_CONTAINER_WORKDIR = "/workspace";
const DEFAULT_MICROVM_PROVIDER = "vercel-sandbox";
const DEFAULT_MICROVM_RUNTIME = "node24";
const UNKNOWN_RUNTIME_DIGEST = "unknown";

type ContractMetadataInput<S extends string> = {
  schema: S;
  createdAt: string;
};

function metadata<S extends string>(input: ContractMetadataInput<S>) {
  return {
    schema: input.schema,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: input.createdAt
  };
}

function terminalStatus(outputs: readonly HarnessCandidateOutput[]): ModelFusionStatus {
  // An abandoned straggler must not fail the whole run: the surviving
  // candidates are the run's result (that is the point of the policy).
  const counted = outputs.filter((output) => !isAbandonedStraggler(output));
  const considered = counted.length > 0 ? counted : outputs;
  if (considered.some((output) => output.status === "failed")) return "failed";
  if (considered.some((output) => output.status === "requires_action")) return "requires_action";
  if (considered.every((output) => output.status === "skipped")) return "skipped";
  return "succeeded";
}

/** Abort reason + candidate finish reason for a straggler dropped by the grace policy. */
export const STRAGGLER_ABANDONED = "straggler_abandoned";

function isAbandonedStraggler(output: HarnessCandidateOutput): boolean {
  return output.status === "failed" && output.endReason?.detail === STRAGGLER_ABANDONED;
}

/**
 * Await all candidate runs with a straggler grace window: when the first
 * usable (succeeded) candidate settles and others are still running, a timer
 * of `graceMs` starts; on expiry every still-pending candidate is aborted via
 * `abandon(ordinal)` and the wait continues until the aborted runs settle
 * (harnesses kill their children on abort, so this is prompt). Without
 * `graceMs` this is exactly `Promise.allSettled`.
 */
async function settleWithStragglerGrace<T>(
  runs: readonly Promise<T>[],
  options: {
    graceMs: number | undefined;
    isUsable: (value: T) => boolean;
    abandon: (ordinal: number) => void;
  }
): Promise<{ settled: PromiseSettledResult<T>[]; abandonedOrdinals: ReadonlySet<number> }> {
  const abandonedOrdinals = new Set<number>();
  const graceMs = options.graceMs;
  if (graceMs === undefined || graceMs <= 0 || runs.length <= 1) {
    return { settled: await Promise.allSettled(runs), abandonedOrdinals };
  }
  const pending = new Set<number>(runs.keys());
  let timer: NodeJS.Timeout | undefined;
  const startGraceTimer = (): void => {
    if (timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      for (const ordinal of pending) {
        abandonedOrdinals.add(ordinal);
        options.abandon(ordinal);
      }
    }, graceMs);
  };
  const settled = await Promise.all(
    runs.map((run, ordinal) =>
      run.then(
        (value): PromiseSettledResult<T> => {
          pending.delete(ordinal);
          if (options.isUsable(value)) startGraceTimer();
          return { status: "fulfilled", value };
        },
        (reason): PromiseSettledResult<T> => {
          pending.delete(ordinal);
          return { status: "rejected", reason };
        }
      )
    )
  );
  if (timer !== undefined) clearTimeout(timer);
  return { settled, abandonedOrdinals };
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
  if (output.summary !== undefined) {
    metadata.summary = output.summary;
  }
  if (worktree !== undefined) {
    metadata.base_git_sha = worktree.baseGitSha;
    metadata.snapshot_hash = worktree.snapshotHash;
  }
  Object.assign(metadata, output.metadata ?? {});
  if (metadata.hardening === undefined) {
    metadata.hardening = hardeningToJson(fallbackCandidateHardening(descriptor));
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
  const base: Record<string, JsonValue> = {
    requested_isolation: isolation?.kind ?? "process",
    runtime_id: descriptor.runtime.id,
    ...(descriptor.runtime.environmentId !== undefined
      ? { environment_id: descriptor.runtime.environmentId }
      : {})
  };
  if (isolation?.kind === "container") {
    return {
      ...base,
      image: isolation.image ?? DEFAULT_CONTAINER_IMAGE,
      engine: isolation.engine ?? DEFAULT_CONTAINER_ENGINE,
      driver: isolation.driver?.id ?? isolation.engine ?? DEFAULT_CONTAINER_ENGINE
    };
  }
  if (isolation?.kind === "microvm") {
    return {
      ...base,
      provider: isolation.provider ?? DEFAULT_MICROVM_PROVIDER,
      runtime: isolation.runtime ?? DEFAULT_MICROVM_RUNTIME,
      driver: isolation.driver?.id ?? `${isolation.provider ?? DEFAULT_MICROVM_PROVIDER}-driver`,
      ...(isolation.snapshotId !== undefined ? { snapshot_id: isolation.snapshotId } : {}),
      ...(isolation.sandboxId !== undefined ? { sandbox_id: isolation.sandboxId } : {}),
      ...(isolation.imageDigest !== undefined ? { image_digest: isolation.imageDigest } : {}),
      runtime_digest: isolation.runtimeDigest ?? UNKNOWN_RUNTIME_DIGEST
    };
  }
  return base;
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
      ...(isolation?.kind === "container"
        ? { image: isolation.image ?? DEFAULT_CONTAINER_IMAGE }
        : {}),
      ...(isolation?.kind === "microvm"
        ? {
            provider: isolation.provider ?? DEFAULT_MICROVM_PROVIDER,
            runtime: isolation.runtime ?? DEFAULT_MICROVM_RUNTIME,
            ...(isolation.snapshotId !== undefined ? { snapshot_id: isolation.snapshotId } : {}),
            ...(isolation.sandboxId !== undefined ? { sandbox_id: isolation.sandboxId } : {}),
            ...(isolation.imageDigest !== undefined ? { image_digest: isolation.imageDigest } : {}),
            runtime_digest: isolation.runtimeDigest ?? UNKNOWN_RUNTIME_DIGEST
          }
        : {}),
      workdir: mountPolicy?.workdir ?? DEFAULT_CONTAINER_WORKDIR
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

export async function runEnsembleLegacy(descriptor: EnsembleDescriptor): Promise<EnsembleRunResult> {
  assertDescriptor(descriptor);
  const createdAt = new Date().toISOString();
  const capabilities = descriptor.harness.capabilities(descriptor);
  const harnessKind = descriptor.harness.harnessKind ?? "generic";
  const outputRoot = defaultOutputRoot(descriptor);
  const store = createArtifactStore(`${outputRoot}/artifacts`);
  const worktreePlan = createWorktreePlan(descriptor);
  const request: HarnessRunRequestV1 = {
    ...metadata({ schema: "harness-run-request.v1", createdAt }),
    request_id: `ensemble_req_${descriptor.id}`,
    harness_kind: harnessKind,
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
    // Every candidate still settles before continuing so a failure cannot leave
    // siblings running while we tear down their worktrees — but a straggler
    // grace window (policy.stragglerGraceMs) bounds how long a stuck candidate
    // can hold a finished sibling's result hostage: once the first candidate
    // succeeds, remaining runs are aborted after the grace period and settle
    // as failed (straggler_abandoned) instead of failing the whole turn.
    const candidateAborts = descriptor.models.map(() => new AbortController());
    const abortAll = (reason: unknown): void => {
      for (const controller of candidateAborts) controller.abort(reason);
    };
    if (descriptor.signal !== undefined) {
      if (descriptor.signal.aborted) abortAll(descriptor.signal.reason);
      else {
        const outerSignal = descriptor.signal;
        outerSignal.addEventListener("abort", () => abortAll(outerSignal.reason), { once: true });
      }
    }
    const runs = descriptor.models.map((model, ordinal) =>
      Promise.resolve(
        descriptor.harness.run({
          descriptor,
          request,
          model,
          ordinal,
          prepared,
          worktree: worktreePlan?.worktrees[ordinal],
          signal: candidateAborts[ordinal]?.signal as AbortSignal
        })
      )
    );
    const { settled, abandonedOrdinals } = await settleWithStragglerGrace(runs, {
      graceMs: descriptor.policy.stragglerGraceMs,
      isUsable: (output) => output.status === "succeeded",
      abandon: (ordinal) => candidateAborts[ordinal]?.abort(new Error(STRAGGLER_ABANDONED))
    });
    // A hard failure still aborts the run (re-thrown) once all candidates have
    // stopped — unless the candidate was deliberately abandoned, in which case
    // it settles as a failed output instead of poisoning the surviving results.
    const rejection = settled.find(
      (result, ordinal): result is PromiseRejectedResult =>
        result.status === "rejected" && !abandonedOrdinals.has(ordinal)
    );
    if (rejection !== undefined) throw rejection.reason;
    outputs = settled.map((result, ordinal) => {
      if (result.status === "fulfilled") return result.value;
      const model = descriptor.models[ordinal] as EnsembleModel;
      return {
        candidateId: `${descriptor.id}_${model.id}_${ordinal}`,
        model,
        status: "failed",
        endReason: { kind: "aborted", detail: STRAGGLER_ABANDONED },
        summary: `abandoned after the straggler grace window (${errorMessage(result.reason)})`
      } satisfies HarnessCandidateOutput;
    });
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
        harness_kind: harnessKind,
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
        return {
          candidateId: candidate.candidate_id,
          modelId: output?.model.id ?? "",
          model: output?.model.model ?? "",
          ...(candidate.model_call_id ? { modelCallId: candidate.model_call_id } : {}),
          status: candidate.status,
          ...(candidate.branch_name ? { branchName: candidate.branch_name } : {}),
          ...(candidate.worktree_path ? { worktreePath: candidate.worktree_path } : {}),
          toolExecutionIds: output?.toolRecords?.map((record) => record.execution_id) ?? [],
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
      harness_kind: harnessKind,
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

export async function runEnsemble(descriptor: EnsembleDescriptor): Promise<EnsembleRunResult> {
  const { ensembleRunWorkflow } = await import("./legacy-workflows.js");
  const result = await ensembleRunWorkflow({ descriptor }).run({ runId: `ensemble_${descriptor.id}` });
  const output = result.finalArtifacts[0]?.value as EnsembleRunResult | undefined;
  if (output === undefined) throw new Error("runEnsemble kernel wrapper produced no result");
  return output;
}

export const ensemble = {
  run: runEnsemble
} as const;
