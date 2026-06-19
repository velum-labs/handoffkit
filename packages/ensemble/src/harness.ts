import type {
  ArtifactRef,
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JudgeSynthesisRecordV1,
  JsonValue,
  ModelFusionHarnessKind,
  ModelCallRecordV1,
  ModelFusionCapabilityStatus,
  ModelFusionSideEffects,
  ModelFusionStatus,
  ToolExecutionRecordV1
} from "@fusionkit/protocol";

import type { CandidateWorktree } from "./worktree.js";
import type {
  JudgeSynthesizer,
  SynthesisFailureSummary,
  SynthesisRepairAttempt
} from "./judge.js";

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

export type TrajectoryVerification = {
  status: ModelFusionStatus;
  evidence: string[];
  exitCode?: number;
};

/**
 * A normalized agent trajectory produced by one panel model: the ordered
 * reasoning/tool-call/observation/output sequence plus the final output and
 * any verification. This is the unit of trajectory-level fusion.
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
  diff?: string;
  verification?: TrajectoryVerification;
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
};

export type VerificationProfile = {
  id: string;
  command?: string;
  requiredEvidence: string[];
};

export type HarnessCapabilities = Record<string, ModelFusionCapabilityStatus>;

export type HarnessArtifact = ArtifactRef;

export type HarnessToolRecord = Pick<
  ToolExecutionRecordV1,
  "execution_id" | "plan_id" | "status" | "output_hash" | "error"
>;

export type HarnessCandidateOutput = {
  candidateId?: string;
  model: EnsembleModel;
  status: ModelFusionStatus;
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
  verification?: {
    status: ModelFusionStatus;
    evidence: string[];
    exitCode?: number;
  };
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

export type EnsembleDescriptor = {
  id: string;
  harness: HarnessAdapter;
  models: EnsembleModel[];
  runtime: EnsembleRuntime;
  judge: EnsembleJudge;
  policy: EnsemblePolicy;
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
  repairAttempts?: readonly SynthesisRepairAttempt[];
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
  diffArtifacts: HarnessArtifact[];
  verification?: HarnessCandidateOutput["verification"];
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
  repairAttempts?: SynthesisRepairAttempt[];
  failureSummary?: SynthesisFailureSummary;
};
