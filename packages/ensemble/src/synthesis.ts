import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertJudgeSynthesisRecordV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH
} from "@fusionkit/protocol";
import type {
  HarnessCandidateRecordV1,
  JudgeSynthesisRecordV1,
  JsonValue,
  ModelFusionStatus
} from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";

import type { ArtifactStore } from "./artifacts.js";
import type {
  EnsembleDescriptor,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessToolRecord
} from "./harness.js";
import type {
  JudgeCandidateEvidence,
  JudgeInput,
  JudgeSynthesisOutput,
  SynthesisFailureSummary
} from "./judge.js";
import { PRODUCER, PRODUCER_GIT_SHA, PRODUCER_VERSION } from "./provenance.js";

export type SynthesisResult = {
  judgeInput: JudgeInput;
  judgeSynthesisRecord: JudgeSynthesisRecordV1;
  artifacts: HarnessArtifact[];
  finalPatchPath: string | null;
  failureSummary?: SynthesisFailureSummary;
};

export type RunSynthesisInput = {
  descriptor: EnsembleDescriptor;
  candidates: readonly HarnessCandidateRecordV1[];
  outputs: readonly HarnessCandidateOutput[];
  artifacts: readonly HarnessArtifact[];
  toolRecords: readonly HarnessToolRecord[];
  modelCallRecords: JudgeInput["modelCallRecords"];
  reviewEvidence?: JudgeInput["reviewEvidence"];
  workspace?: string;
  baseGitSha?: string;
  store: ArtifactStore;
};

type StoredHarnessArtifact = HarnessArtifact & { path?: string };

function metadata(createdAt: string) {
  return {
    schema: "judge-synthesis-record.v1" as const,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: createdAt
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function candidateEvidence(
  candidates: readonly HarnessCandidateRecordV1[],
  outputs: readonly HarnessCandidateOutput[]
): JudgeCandidateEvidence[] {
  return candidates.map((candidate, index) => {
    const output = outputs[index];
    return {
      candidateId: candidate.candidate_id,
      modelId: String(candidate.metadata?.model_id ?? output?.model.id ?? ""),
      model: String(candidate.metadata?.model ?? output?.model.model ?? ""),
      status: candidate.status,
      artifacts: candidate.artifacts ?? [],
      ...(output?.trajectory ? { trajectory: output.trajectory } : {})
    };
  });
}

function createSynthesisWorktree(input: RunSynthesisInput): string | undefined {
  if (!input.workspace || !input.baseGitSha) return undefined;
  const root = mkdtempSync(join(tmpdir(), `warrant-synthesis-${safeSegment(input.descriptor.id)}-`));
  const worktree = join(root, "final");
  gitText(input.workspace, ["worktree", "add", "--detach", worktree, input.baseGitSha]);
  return worktree;
}

function removeSynthesisWorktree(workspace: string | undefined, worktree: string | undefined): void {
  if (!worktree) return;
  if (workspace) gitText(workspace, ["worktree", "remove", "--force", worktree], { allowFail: true });
  rmSync(join(worktree, ".."), { recursive: true, force: true });
}

function applyPatch(worktree: string | undefined, patch: string | undefined): boolean {
  if (!worktree || !patch || patch.length === 0) return true;
  const patchPath = join(worktree, "judge.patch");
  writeFileSync(patchPath, patch);
  const applied = spawnSync("git", ["apply", "--binary", "--whitespace=nowarn", patchPath], {
    cwd: worktree,
    encoding: "utf8"
  });
  return applied.status === 0;
}

function diffWorktree(worktree: string | undefined, baseGitSha: string | undefined): string {
  if (!worktree || !baseGitSha) return "";
  gitText(worktree, ["add", "-A"], { allowFail: true });
  return gitText(worktree, ["diff", "--cached", "--binary", baseGitSha], { allowFail: true });
}

function recordFor(
  input: RunSynthesisInput,
  output: JudgeSynthesisOutput,
  status: ModelFusionStatus,
  decision: JudgeSynthesisRecordV1["decision"],
  metrics: Record<string, JsonValue>
): JudgeSynthesisRecordV1 {
  const record: JudgeSynthesisRecordV1 = {
    ...metadata(new Date().toISOString()),
    synthesis_id: `synthesis_${input.descriptor.id}`,
    input_trajectory_ids: input.candidates.map((candidate) => candidate.candidate_id),
    status,
    decision,
    ...(output.judgeModelCallId ? { judge_model_call_id: output.judgeModelCallId } : {}),
    ...(output.selectedCandidateId
      ? { selected_trajectory_id: output.selectedCandidateId }
      : {}),
    ...(output.rationale ? { rationale: output.rationale } : {}),
    final_output: output.finalOutput,
    ...(output.score !== undefined ? { score: output.score } : {}),
    metrics
  };
  assertJudgeSynthesisRecordV1(record);
  return record;
}

function artifactRef(artifact: StoredHarnessArtifact): HarnessArtifact {
  const { path: _path, ...ref } = artifact;
  return ref;
}

export async function runJudgeSynthesis(input: RunSynthesisInput): Promise<SynthesisResult | undefined> {
  const synthesizer = input.descriptor.judge.synthesizer;
  if (!synthesizer) return undefined;

  const judgeInput: JudgeInput = {
    descriptor: input.descriptor,
    candidates: candidateEvidence(input.candidates, input.outputs),
    artifacts: input.artifacts,
    toolRecords: input.toolRecords,
    modelCallRecords: input.modelCallRecords,
    ...(input.reviewEvidence ? { reviewEvidence: input.reviewEvidence } : {})
  };
  const artifacts: HarnessArtifact[] = [
    artifactRef(input.store.writeJson({
      artifactId: `${input.descriptor.id}_judge_input`,
      kind: "metrics",
      value: judgeInput
    }))
  ];
  let finalPatchPath: string | null = null;
  let failureSummary: SynthesisFailureSummary | undefined;
  // Create the synthesis worktree lazily: a capture-only synthesizer (the panel
  // trajectory capture used by `runFusionPanels`) produces no patch, so it never
  // touches a worktree — skip the git add/remove. fusionkit owns no verification,
  // so there is no verify/repair gate here: synthesize, apply the fused patch,
  // and record the result.
  let worktree: string | undefined;
  try {
    const output = await synthesizer.synthesize(judgeInput);
    const needsWorktree = output.patch?.content !== undefined && output.patch.content.length > 0;
    if (needsWorktree) worktree = createSynthesisWorktree(input);
    const applied = applyPatch(worktree, output.patch?.content);
    if (!applied) {
      const conflict = artifactRef(input.store.writeJson({
        artifactId: `${input.descriptor.id}_patch_conflict`,
        kind: "other",
        value: {
          type: "patch_conflict",
          sourceCandidateIds: output.patch?.sourceCandidateIds ?? [],
          patch: output.patch?.content ?? ""
        }
      }));
      artifacts.push(conflict);
      failureSummary = { reason: "patch_conflict" };
      return {
        judgeInput,
        artifacts,
        finalPatchPath,
        failureSummary,
        judgeSynthesisRecord: recordFor(input, output, "failed", "failed", {
          contributions: output.contributions ?? [],
          rejections: output.rejections ?? [],
          failure: failureSummary
        })
      };
    }

    const finalPatch = diffWorktree(worktree, input.baseGitSha);
    if (finalPatch.length > 0) {
      const patchArtifact = input.store.writeText({
        artifactId: `${input.descriptor.id}_final_patch`,
        kind: "patch",
        content: finalPatch,
        suffix: ".patch"
      });
      artifacts.push(artifactRef(patchArtifact));
      finalPatchPath = patchArtifact.uri ?? null;
    }

    return {
      judgeInput,
      artifacts,
      finalPatchPath,
      judgeSynthesisRecord: recordFor(input, output, "succeeded", output.decision, {
        contributions: output.contributions ?? [],
        rejections: output.rejections ?? []
      })
    };
  } finally {
    removeSynthesisWorktree(input.workspace, worktree);
  }
}
