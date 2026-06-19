import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hashCanonicalSha256 } from "@warrant/protocol";
import { gitText } from "@warrant/workspace";

import type { EnsembleDescriptor, EnsembleModel } from "./harness.js";

export type CandidateWorktree = {
  candidateId: string;
  modelId: string;
  branchName: string;
  path: string;
  baseGitSha: string;
  snapshotHash: string;
  sealed: boolean;
  cleaned: boolean;
};

export type WorktreePlan = {
  workspace: string;
  baseGitSha: string;
  snapshotHash: string;
  root: string;
  worktrees: CandidateWorktree[];
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

export function defaultOutputRoot(descriptor: EnsembleDescriptor): string {
  const base = descriptor.outputRoot ?? join(descriptor.workspace ?? tmpdir(), ".warrant", "ensemble");
  return resolve(base, safeSegment(descriptor.id));
}

export function candidateId(descriptor: EnsembleDescriptor, model: EnsembleModel, ordinal: number): string {
  return `${descriptor.id}_${model.id}_${ordinal}`.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

export function createWorktreePlan(descriptor: EnsembleDescriptor): WorktreePlan | undefined {
  if (!descriptor.workspace) return undefined;
  const workspace = resolve(descriptor.workspace);
  const baseGitSha = descriptor.baseGitSha || gitText(workspace, ["rev-parse", "HEAD"]).trim();
  const root = mkdtempSync(join(tmpdir(), `warrant-ensemble-${safeSegment(descriptor.id)}-`));
  const snapshotHash = hashCanonicalSha256({
    workspace,
    baseGitSha,
    descriptorId: descriptor.id,
    models: descriptor.models.map((model) => model.id)
  });
  const worktrees: CandidateWorktree[] = [];
  try {
    for (const [ordinal, model] of descriptor.models.entries()) {
      const id = candidateId(descriptor, model, ordinal);
      const path = join(root, id);
      const branchName = `warrant/ensemble/${safeSegment(descriptor.id)}/${safeSegment(model.id)}`;
      gitText(workspace, ["worktree", "add", "--detach", path, baseGitSha]);
      worktrees.push({
        candidateId: id,
        modelId: model.id,
        branchName,
        path,
        baseGitSha,
        snapshotHash,
        sealed: false,
        cleaned: false
      });
    }
  } catch (error) {
    // A mid-loop failure must not leak the worktrees already added or the root.
    for (const worktree of worktrees) {
      gitText(workspace, ["worktree", "remove", "--force", worktree.path], { allowFail: true });
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { workspace, baseGitSha, snapshotHash, root, worktrees };
}

export function sealCandidateWorktree(worktree: CandidateWorktree): CandidateWorktree {
  return Object.freeze({ ...worktree, sealed: true });
}

export function cleanupCandidateWorktree(
  workspace: string,
  worktree: CandidateWorktree
): CandidateWorktree {
  gitText(workspace, ["worktree", "remove", "--force", worktree.path], { allowFail: true });
  rmSync(worktree.path, { recursive: true, force: true });
  return Object.freeze({ ...worktree, cleaned: true });
}

export function cleanupWorktreePlan(plan: WorktreePlan): CandidateWorktree[] {
  const cleaned = plan.worktrees.map((worktree) =>
    cleanupCandidateWorktree(plan.workspace, worktree)
  );
  rmSync(plan.root, { recursive: true, force: true });
  return cleaned;
}

export function diffCandidateWorktree(worktree: CandidateWorktree): string {
  gitText(worktree.path, ["add", "-A"], { allowFail: true });
  return gitText(worktree.path, ["diff", "--cached", "--binary", worktree.baseGitSha], {
    allowFail: true
  });
}
