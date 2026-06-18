import type { JudgeSynthesisDecision, ModelCallRecordV1, ModelFusionStatus } from "@warrant/protocol";

import type {
  EnsembleDescriptor,
  HarnessArtifact,
  HarnessCandidateOutput,
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
  verification?: HarnessCandidateOutput["verification"];
  trajectory?: HarnessTrajectory;
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

export type JudgeRepairInput = JudgeInput & {
  failureEvidence: SynthesisVerificationResult;
  priorOutput: JudgeSynthesisOutput;
};

export type SynthesisVerificationResult = {
  status: ModelFusionStatus;
  evidence: string[];
  exitCode?: number;
};

export type SynthesisFailureSummary = {
  reason: string;
  verification?: SynthesisVerificationResult;
  repair?: SynthesisVerificationResult;
};

export type SynthesisRepairAttempt = {
  round: number;
  verification: SynthesisVerificationResult;
  status: ModelFusionStatus;
};

export type JudgeVerificationInput = {
  descriptor: EnsembleDescriptor;
  worktreePath: string;
  output: JudgeSynthesisOutput;
  repairRound: number;
};

export type JudgeSynthesizer = {
  synthesize(input: JudgeInput): Promise<JudgeSynthesisOutput> | JudgeSynthesisOutput;
  repair?(input: JudgeRepairInput): Promise<JudgeSynthesisOutput> | JudgeSynthesisOutput;
  verify?(
    input: JudgeVerificationInput
  ): Promise<SynthesisVerificationResult> | SynthesisVerificationResult;
};

export type MockJudgeSynthesizerOptions = {
  output: JudgeSynthesisOutput;
  repairOutput?: JudgeSynthesisOutput;
  verificationResults?: SynthesisVerificationResult[];
};

export function createMockJudgeSynthesizer(
  options: MockJudgeSynthesizerOptions
): JudgeSynthesizer {
  let verificationIndex = 0;
  return {
    synthesize: () => options.output,
    repair: options.repairOutput ? () => options.repairOutput as JudgeSynthesisOutput : undefined,
    verify: () => {
      const result = options.verificationResults?.[verificationIndex];
      verificationIndex += 1;
      return (
        result ?? {
          status: "succeeded",
          evidence: ["mock judge verification passed"],
          exitCode: 0
        }
      );
    }
  };
}
