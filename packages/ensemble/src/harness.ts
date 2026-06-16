import type {
  ArtifactRef,
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JudgeSynthesisRecordV1,
  JsonValue,
  ModelCallRecordV1,
  ModelFusionCapabilityStatus,
  ModelFusionSideEffects,
  ModelFusionStatus,
  ToolExecutionRecordV1
} from "@warrant/protocol";

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

export type EnsembleRuntime = {
  id: string;
  environmentId?: string;
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
  diffArtifacts: HarnessArtifact[];
  verification?: HarnessCandidateOutput["verification"];
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
