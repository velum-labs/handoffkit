import type {
  ArtifactRef,
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JudgeSynthesisRecordV1,
  ModelFusionHarnessKind,
  ModelCallRecordV1,
  ModelFusionSideEffects,
  ModelFusionStatus,
  ToolExecutionRecordV1
} from "@fusionkit/protocol";
import type { CapabilityStatus, JsonValue, ModelUsage } from "@velum-labs/routekit-contracts";

import type { CandidateWorktree } from "./worktree.js";
import type { JudgeSynthesizer, SynthesisFailureSummary } from "./judge.js";

export type EnsembleModel = {
  id: string;
  model: string;
  endpointId?: string;
};

export type TrajectoryStepType = "reasoning" | "tool_call" | "observation" | "output";

/** One step of an agent trajectory (mirrors harness-trajectory.v1 steps). */
export type TrajectoryStep = {
  index: number;
  type: TrajectoryStepType;
  text?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_input?: string;
  is_error?: boolean;
};

/**
 * A normalized agent trajectory produced by one panel model: the ordered
 * reasoning/tool-call/observation/output sequence plus the final output. This is
 * the unit of trajectory-level fusion. fusionkit does not own verification, so a
 * trajectory carries no pass/fail verdict; any tests a harness ran are just raw
 * observation steps.
 */
export type HarnessTrajectory = {
  trajectoryId: string;
  modelId: string;
  model?: string;
  candidateId?: string;
  harnessKind?: ModelFusionHarnessKind;
  status: ModelFusionStatus;
  steps: TrajectoryStep[];
  finalOutput: string;
  usage?: ModelUsage;
  latencyMs?: number;
  providerMetadata?: Record<string, JsonValue>;
  diff?: string;
  endReason?: HarnessEndReason;
};

/**
 * Why a candidate's harness run ended — persisted into the session record so
 * "why did it stop?" is answerable from the trace UI instead of forensics on
 * harness temp dirs. `completed` means the tool itself reported a finished
 * turn; `aborted` means the process exited cleanly WITHOUT reporting one
 * (e.g. the CLI was interrupted mid-turn and shut down gracefully).
 */
export type HarnessEndReason = {
  kind: "completed" | "aborted" | "timeout" | "exit_error" | "spawn_error" | "unknown";
  exitCode?: number;
  timedOut?: boolean;
  detail?: string;
};

export type CandidateIsolationKind = "process" | "container" | "microvm";

export type CandidateActualIsolationKind = CandidateIsolationKind | "vercel-sandbox";

export type CandidateIsolationNetworkPolicy = {
  defaultDeny: boolean;
  allowHosts: string[];
  enforce?: boolean;
};

export type CandidateIsolationMountPolicy = {
  workdir?: string;
  worktreeWritable?: boolean;
  readOnlyCachePaths?: string[];
  ignoredDirs?: string[];
};

export type CandidateIsolationSecretPolicy = {
  secretNames?: string[];
  secretValueHashes?: string[];
  injectedEnvNames?: string[];
};

export type CandidateContainerDriverInput = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  image: string;
  workdir: string;
  mountPolicy: Required<CandidateIsolationMountPolicy>;
  networkPolicy: Required<CandidateIsolationNetworkPolicy>;
  /** Aborts the container run (and reaps the container) when fired. */
  signal?: AbortSignal;
};

export type CandidateContainerDriverResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  cleanup?: {
    attempted: boolean;
    succeeded: boolean;
    error?: string;
  };
};

export type CandidateContainerDriver = {
  id: string;
  supportsNetworkPolicy: boolean;
  execute(
    input: CandidateContainerDriverInput
  ): Promise<CandidateContainerDriverResult> | CandidateContainerDriverResult;
};

export type CandidateMicrovmProvider = "vercel-sandbox" | (string & {});

export type CandidateMicrovmRuntimeMetadata = {
  provider?: CandidateMicrovmProvider;
  runtime?: string;
  snapshotId?: string;
  sandboxId?: string;
  imageDigest?: string;
  runtimeDigest?: string;
};

export type CandidateMicrovmDriverInput = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  provider: CandidateMicrovmProvider;
  runtime: string;
  snapshotId?: string;
  workdir: string;
  mountPolicy: Required<CandidateIsolationMountPolicy>;
  networkPolicy: Required<CandidateIsolationNetworkPolicy>;
  secretPolicy: Required<CandidateIsolationSecretPolicy>;
  /** Aborts the sandbox run when fired. */
  signal?: AbortSignal;
};

export type CandidateMicrovmDriverResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  actualIsolation?: Extract<CandidateActualIsolationKind, "microvm" | "vercel-sandbox">;
  runtime?: CandidateMicrovmRuntimeMetadata;
  cleanup?: {
    attempted: boolean;
    succeeded: boolean;
    timedOut?: boolean;
    error?: string;
  };
};

export type CandidateMicrovmDriver = {
  id: string;
  provider: CandidateMicrovmProvider;
  supportsNetworkPolicy: boolean;
  execute(
    input: CandidateMicrovmDriverInput
  ): Promise<CandidateMicrovmDriverResult> | CandidateMicrovmDriverResult;
};

export type CandidateIsolationConfig =
  | {
      kind: "process";
      networkPolicy?: CandidateIsolationNetworkPolicy;
      mountPolicy?: CandidateIsolationMountPolicy;
      secretPolicy?: CandidateIsolationSecretPolicy;
    }
  | {
      kind: "container";
      image?: string;
      engine?: "docker" | "podman";
      driver?: CandidateContainerDriver;
      networkPolicy?: CandidateIsolationNetworkPolicy;
      mountPolicy?: CandidateIsolationMountPolicy;
      secretPolicy?: CandidateIsolationSecretPolicy;
    }
  | {
      kind: "microvm";
      provider?: CandidateMicrovmProvider;
      runtime?: string;
      snapshotId?: string;
      sandboxId?: string;
      imageDigest?: string;
      runtimeDigest?: string;
      driver?: CandidateMicrovmDriver;
      networkPolicy?: CandidateIsolationNetworkPolicy;
      mountPolicy?: CandidateIsolationMountPolicy;
      secretPolicy?: CandidateIsolationSecretPolicy;
    };

export type CandidateHardeningMetadata = {
  requested_isolation: CandidateIsolationKind;
  actual_isolation: CandidateActualIsolationKind;
  runtime: {
    image?: string;
    driver?: string;
    provider?: CandidateMicrovmProvider;
    runtime?: string;
    snapshot_id?: string;
    sandbox_id?: string;
    image_digest?: string;
    runtime_digest?: string;
    workdir: string;
  };
  mount_policy: {
    worktree_writable: boolean;
    read_only_caches: string[];
    ignored_dirs: string[];
  };
  network_policy: {
    default_deny: boolean;
    allow_hosts: string[];
    enforced: boolean;
  };
  cleanup: {
    attempted: boolean;
    succeeded: boolean;
    status: "not_required" | "succeeded" | "failed" | "timed_out";
    timed_out?: boolean;
    error?: string;
  };
  secret_absence: {
    secret_names: string[];
    secret_value_hashes: string[];
    injected_env_names: string[];
    scanned: boolean;
    leaks_found: boolean;
    scan_scope: string[];
    leak_count: number;
  };
};

/**
 * Serialize hardening metadata as a `JsonValue`. The shape is JSON-compatible by
 * construction, but TypeScript cannot prove an object type with optional members
 * satisfies the `JsonValue` index signature, so this typed mapper does the
 * conversion explicitly (omitting absent optionals) instead of an unchecked cast.
 */
export function hardeningToJson(hardening: CandidateHardeningMetadata): JsonValue {
  return {
    requested_isolation: hardening.requested_isolation,
    actual_isolation: hardening.actual_isolation,
    runtime: {
      ...(hardening.runtime.image !== undefined ? { image: hardening.runtime.image } : {}),
      ...(hardening.runtime.driver !== undefined ? { driver: hardening.runtime.driver } : {}),
      ...(hardening.runtime.provider !== undefined ? { provider: hardening.runtime.provider } : {}),
      ...(hardening.runtime.runtime !== undefined ? { runtime: hardening.runtime.runtime } : {}),
      ...(hardening.runtime.snapshot_id !== undefined ? { snapshot_id: hardening.runtime.snapshot_id } : {}),
      ...(hardening.runtime.sandbox_id !== undefined ? { sandbox_id: hardening.runtime.sandbox_id } : {}),
      ...(hardening.runtime.image_digest !== undefined ? { image_digest: hardening.runtime.image_digest } : {}),
      ...(hardening.runtime.runtime_digest !== undefined
        ? { runtime_digest: hardening.runtime.runtime_digest }
        : {}),
      workdir: hardening.runtime.workdir
    },
    mount_policy: {
      worktree_writable: hardening.mount_policy.worktree_writable,
      read_only_caches: [...hardening.mount_policy.read_only_caches],
      ignored_dirs: [...hardening.mount_policy.ignored_dirs]
    },
    network_policy: {
      default_deny: hardening.network_policy.default_deny,
      allow_hosts: [...hardening.network_policy.allow_hosts],
      enforced: hardening.network_policy.enforced
    },
    cleanup: {
      attempted: hardening.cleanup.attempted,
      succeeded: hardening.cleanup.succeeded,
      status: hardening.cleanup.status,
      ...(hardening.cleanup.timed_out !== undefined ? { timed_out: hardening.cleanup.timed_out } : {}),
      ...(hardening.cleanup.error !== undefined ? { error: hardening.cleanup.error } : {})
    },
    secret_absence: {
      secret_names: [...hardening.secret_absence.secret_names],
      secret_value_hashes: [...hardening.secret_absence.secret_value_hashes],
      injected_env_names: [...hardening.secret_absence.injected_env_names],
      scanned: hardening.secret_absence.scanned,
      leaks_found: hardening.secret_absence.leaks_found,
      scan_scope: [...hardening.secret_absence.scan_scope],
      leak_count: hardening.secret_absence.leak_count
    }
  };
}

export type EnsembleRuntime = {
  id: string;
  environmentId?: string;
  isolation?: CandidateIsolationConfig;
};

export type EnsembleJudge = {
  id: string;
  model?: string;
  synthesizer?: JudgeSynthesizer;
};

export type EnsemblePolicy = {
  id: string;
  allowedTools: string[];
  sideEffects: ModelFusionSideEffects;
  timeoutMs?: number;
  budgetUsd?: number;
  /**
   * Straggler policy: once the first candidate has *succeeded*, still-running
   * siblings get this much longer before they are aborted and settled as
   * failed (`straggler_abandoned`). Unset disables the policy (all candidates
   * are awaited, the pre-existing behavior), so one stuck candidate can hold a
   * finished sibling's result hostage until the caller's hard timeout.
   */
  stragglerGraceMs?: number;
};

export type VerificationProfile = {
  id: string;
  command?: string;
  requiredEvidence: string[];
};

export type HarnessCapabilities = Record<string, CapabilityStatus>;

export type HarnessArtifact = ArtifactRef;

export type HarnessToolRecord = Pick<
  ToolExecutionRecordV1,
  "execution_id" | "plan_id" | "status" | "output_hash" | "error"
>;

export type HarnessCandidateOutput = {
  candidateId?: string;
  model: EnsembleModel;
  status: ModelFusionStatus;
  endReason?: HarnessEndReason;
  modelCallId?: string;
  modelCallRecord?: ModelCallRecordV1;
  branchName?: string;
  worktreePath?: string;
  transcript?: string;
  trajectory?: HarnessTrajectory;
  diff?: string;
  log?: string;
  summary?: string;
  screenshots?: HarnessArtifact[];
  score?: number;
  artifacts?: HarnessArtifact[];
  toolRecords?: HarnessToolRecord[];
  error?: HarnessCandidateRecordV1["error"];
  metadata?: Record<string, JsonValue>;
};

export type HarnessPrepareInput = {
  descriptor: EnsembleDescriptor;
  request: HarnessRunRequestV1;
};

export type HarnessRunInput = {
  descriptor: EnsembleDescriptor;
  request: HarnessRunRequestV1;
  model: EnsembleModel;
  ordinal: number;
  prepared: unknown;
  worktree?: CandidateWorktree;
  /**
   * Aborted when this candidate should stop: the whole panel was cancelled
   * (descriptor signal / caller timeout) or the straggler policy dropped it.
   * Harnesses that spawn child processes must kill them on abort.
   */
  signal?: AbortSignal;
};

export type HarnessCollectInput = {
  descriptor: EnsembleDescriptor;
  request: HarnessRunRequestV1;
  candidates: readonly HarnessCandidateOutput[];
  prepared: unknown;
};

export type HarnessAdapter = {
  id: string;
  harnessKind?: ModelFusionHarnessKind;
  prepare(input: HarnessPrepareInput): Promise<unknown> | unknown;
  run(input: HarnessRunInput): Promise<HarnessCandidateOutput> | HarnessCandidateOutput;
  collectArtifacts(input: HarnessCollectInput): Promise<HarnessArtifact[]> | HarnessArtifact[];
  cleanup?(input: HarnessCollectInput): Promise<void> | void;
  verificationProfile(descriptor: EnsembleDescriptor): VerificationProfile;
  capabilities(descriptor: EnsembleDescriptor): HarnessCapabilities;
};

export type ReviewEvidence = {
  strategy: string;
  scorecards: Record<string, JsonValue>[];
  reason?: string;
};

/**
 * Per-member identity line (panel identity on): tells the model exactly which
 * panel member it is. This makes each member's prompt differ from its peers, so
 * it is gated behind `panelIdentity` (it trades some inter-member decorrelation
 * for self-awareness) and injected at the harness `run`, where the model id and
 * ordinal are known. Lives here (a leaf module) so both the agent harness and the
 * per-tool harness packages can use it without a circular import.
 */
export function panelMemberPreamble(modelId: string, ordinal: number, total: number): string {
  return (
    `You are model "${modelId}", panel member ${ordinal + 1} of ${total} in a FusionKit ` +
    "ensemble answering this task independently."
  );
}

export type EnsembleDescriptor = {
  id: string;
  harness: HarnessAdapter;
  models: EnsembleModel[];
  runtime: EnsembleRuntime;
  judge: EnsembleJudge;
  policy: EnsemblePolicy;
  /** Aborts the whole run: every candidate's per-run signal fires with this reason. */
  signal?: AbortSignal;
  prompt: string;
  sourceRepo: string;
  baseGitSha: string;
  workspace?: string;
  outputRoot?: string;
  cleanupWorktrees?: boolean;
  metadata?: Record<string, JsonValue>;
  reviewEvidence?: ReviewEvidence;
  checks?: never;
};

export type EnsembleRunResult = {
  descriptorId: string;
  harnessRunRequest: HarnessRunRequestV1;
  harnessRunResult: HarnessRunResultV1;
  candidates: readonly HarnessCandidateRecordV1[];
  artifacts: readonly HarnessArtifact[];
  toolRecords: readonly HarnessToolRecord[];
  modelCallRecords: readonly ModelCallRecordV1[];
  verification: VerificationProfile;
  summaryPath?: string;
  summary?: EnsembleRunSummary;
  judgeSynthesisRecord?: JudgeSynthesisRecordV1;
  finalPatchPath?: string | null;
  failureSummary?: SynthesisFailureSummary;
  reviewEvidence?: ReviewEvidence;
};

export type EnsembleCandidateSummary = {
  candidateId: string;
  modelId: string;
  model: string;
  modelCallId?: string;
  status: ModelFusionStatus;
  branchName?: string;
  worktreePath?: string;
  toolExecutionIds: string[];
  hardening?: CandidateHardeningMetadata;
};

export type EnsembleRunSummary = {
  descriptorId: string;
  snapshot?: {
    baseGitSha: string;
    snapshotHash: string;
    workspace: string;
  };
  candidates: EnsembleCandidateSummary[];
  artifacts: HarnessArtifact[];
  modelCallRecords: ModelCallRecordV1[];
  judgeSynthesisRecord?: JudgeSynthesisRecordV1;
  finalPatchPath: string | null;
  failureSummary?: SynthesisFailureSummary;
};
