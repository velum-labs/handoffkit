import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hashCanonicalSha256 } from "@routekit/contracts";
import { gitText } from "@fusionkit/workspace";

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
  /** When `cleaned` is false, why removal did not fully succeed. */
  cleanupError?: string;
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
  const base = descriptor.outputRoot ?? join(descriptor.workspace ?? tmpdir(), ".fusionkit", "ensemble");
  return resolve(base, safeSegment(descriptor.id));
}

export function candidateId(descriptor: EnsembleDescriptor, model: EnsembleModel, ordinal: number): string {
  return `${descriptor.id}_${model.id}_${ordinal}`.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

export function createWorktreePlan(descriptor: EnsembleDescriptor): WorktreePlan | undefined {
  if (!descriptor.workspace) return undefined;
  const workspace = resolve(descriptor.workspace);
  // Sweep stale registrations left by crashed past runs (worktree dirs that no
  // longer exist on disk) so their lingering `.git/worktrees` entries cannot
  // make `git worktree add` fail with a path-reuse conflict below.
  gitText(workspace, ["worktree", "prune"], { allowFail: true });
  const baseGitSha = descriptor.baseGitSha || gitText(workspace, ["rev-parse", "HEAD"]).trim();
  const root = mkdtempSync(join(tmpdir(), `fusionkit-ensemble-${safeSegment(descriptor.id)}-`));
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
      const branchName = `fusionkit/ensemble/${safeSegment(descriptor.id)}/${safeSegment(model.id)}-${ordinal}`;
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
  // Attempt the git-aware removal (drops the .git/worktrees registration too),
  // then the directory, recording honest failure reasons instead of the old
  // allowFail swallow that always reported `cleaned: true`.
  let reason: string | undefined;
  try {
    gitText(workspace, ["worktree", "remove", "--force", worktree.path]);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  try {
    rmSync(worktree.path, { recursive: true, force: true });
  } catch (error) {
    reason = reason ?? (error instanceof Error ? error.message : String(error));
  }
  // The desired end state is "the worktree directory is gone". If it is, the
  // candidate is clean regardless of a stale-registration complaint from git;
  // otherwise surface why.
  const cleaned = !existsSync(worktree.path);
  const cleanupError = cleaned
    ? undefined
    : reason ?? "worktree path still present after removal";
  return Object.freeze({
    ...worktree,
    cleaned,
    ...(cleanupError !== undefined ? { cleanupError } : {})
  });
}

export function cleanupWorktreePlan(plan: WorktreePlan): CandidateWorktree[] {
  const cleaned = plan.worktrees.map((worktree) =>
    cleanupCandidateWorktree(plan.workspace, worktree)
  );
  rmSync(plan.root, { recursive: true, force: true });
  return cleaned;
}

/**
 * Add-then-diff so untracked/new files are included: stage everything, then
 * diff the index against `baseGitSha`. A plain `git diff` misses new files and
 * makes `has_diff` report false negatives for candidates that only created
 * files.
 */
export function diffWorkspace(path: string, baseGitSha: string): string {
  gitText(path, ["add", "-A"], { allowFail: true });
  return gitText(path, ["diff", "--cached", "--binary", baseGitSha], {
    allowFail: true
  });
}

export function diffCandidateWorktree(worktree: CandidateWorktree): string {
  return diffWorkspace(worktree.path, worktree.baseGitSha);
}
