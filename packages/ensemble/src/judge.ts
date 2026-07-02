import type { JudgeSynthesisDecision, ModelCallRecordV1, ModelFusionStatus } from "@fusionkit/protocol";

import type {
  EnsembleDescriptor,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessEndReason,
  HarnessToolRecord,
  HarnessTrajectory,
  ReviewEvidence
} from "./harness.js";

export type JudgeCandidateEvidence = {
  candidateId: string;
  modelId: string;
  model: string;
  status: ModelFusionStatus;
  artifacts: readonly HarnessArtifact[];
  trajectory?: HarnessTrajectory;
  endReason?: HarnessEndReason;
};

export type JudgeInput = {
  descriptor: EnsembleDescriptor;
  candidates: readonly JudgeCandidateEvidence[];
  artifacts: readonly HarnessArtifact[];
  toolRecords: readonly HarnessToolRecord[];
  modelCallRecords: readonly ModelCallRecordV1[];
  reviewEvidence?: ReviewEvidence;
};

export type JudgePatch = {
  content: string;
  sourceCandidateIds?: string[];
  author?: "judge" | "candidate";
};

export type JudgeSynthesisOutput = {
  decision: JudgeSynthesisDecision;
  finalOutput: string;
  rationale?: string;
  selectedCandidateId?: string;
  judgeModelCallId?: string;
  score?: number;
  patch?: JudgePatch;
  contributions?: Array<{ candidateId: string; reason: string }>;
  rejections?: Array<{ candidateId: string; reason: string }>;
};

/**
 * A non-verdict synthesis failure. fusionkit does not own verification, so this
 * only captures structural failures it must surface itself (e.g. a fused patch
 * that does not apply), never a test/exit-code verdict.
 */
export type SynthesisFailureSummary = {
  reason: string;
};

export type JudgeSynthesizer = {
  synthesize(input: JudgeInput): Promise<JudgeSynthesisOutput> | JudgeSynthesisOutput;
};

export type MockJudgeSynthesizerOptions = {
  output: JudgeSynthesisOutput;
};

export function createMockJudgeSynthesizer(
  options: MockJudgeSynthesizerOptions
): JudgeSynthesizer {
  return {
    synthesize: () => options.output
  };
}
