import type {
  ArtifactRef,
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JsonValue,
  ModelFusionCapabilityStatus,
  ModelFusionSideEffects,
  ModelFusionStatus,
  ToolExecutionRecordV1
} from "@warrant/protocol";

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
  transcript?: string;
  diff?: string;
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
  verification: VerificationProfile;
  reviewEvidence?: ReviewEvidence;
};
