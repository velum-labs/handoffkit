import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ManifestFile, WorkspaceManifest } from "@fusionkit/protocol";
import { sha256Hex } from "@routekit/contracts";
import { minimatch } from "minimatch";

import { gitBinary, gitText } from "./git.js";
import {
  parseWorkspaceRelativePath,
  parseWorkspaceRoot,
  resolveInsideWorkspace
} from "./paths.js";

/** Default branch prefix and committer for divergence-safe pulls. */
export const PULL_BRANCH_PREFIX = "fusionkit/";
export const DEFAULT_PULL_COMMITTER = {
  name: "fusionkit",
  email: "fusionkit@localhost"
};
/** Sentinel content hash recorded for files deleted by a run. */
export const DELETED_FILE_HASH = "0".repeat(64);

export const DEFAULT_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*"
];

function git(cwd: string, args: string[], allowFail = false): string {
  return gitText(cwd, args, { allowFail });
}

export function matchesPattern(path: string, pattern: string): boolean {
  const target = pattern.includes("/") ? path : path.split("/").pop() ?? path;
  return minimatch(target, pattern, { dot: true });
}

export type CapturedWorkspace = {
  manifest: WorkspaceManifest;
  bundle: Buffer;
  dirtyDiff?: Buffer;
  untracked: { file: ManifestFile; content: Buffer }[];
};

export type CaptureOptions = {
  allowUntracked?: string[];
  denyPatterns?: string[];
};

export function captureWorkspace(
  repoDir: string,
  options: CaptureOptions = {}
): CapturedWorkspace {
  const root = parseWorkspaceRoot(repoDir);
  const denyPatterns = options.denyPatterns ?? DEFAULT_DENY_PATTERNS;
  const allowUntracked = options.allowUntracked ?? [];

  const baseRef = git(repoDir, ["rev-parse", "HEAD"]).trim();

  const bundlePath = join(
    mkdtempSync(join(tmpdir(), "fusionkit-bundle-")),
    "workspace.bundle"
  );
  git(repoDir, ["bundle", "create", bundlePath, "HEAD"]);
  const bundle = readFileSync(bundlePath);
  rmSync(dirname(bundlePath), { recursive: true, force: true });

  const dirtyDiffBuffer = gitBinary(repoDir, ["diff", "--binary", "HEAD"]);
  const dirtyDiff = dirtyDiffBuffer.length > 0 ? dirtyDiffBuffer : undefined;

  const untrackedPaths = git(repoDir, [
    "ls-files",
    "--others",
    "--exclude-standard"
  ])
    .split("\n")
    .filter((line) => line.length > 0);

  const deniedPaths: string[] = [];
  const untracked: { file: ManifestFile; content: Buffer }[] = [];
  for (const path of untrackedPaths) {
    const rel = parseWorkspaceRelativePath(path);
    if (denyPatterns.some((pattern) => matchesPattern(path, pattern))) {
      deniedPaths.push(rel);
      continue;
    }
    if (!allowUntracked.some((pattern) => matchesPattern(path, pattern))) {
      continue;
    }
    const content = readFileSync(resolveInsideWorkspace(root, rel));
    untracked.push({
      file: { path: rel, hash: sha256Hex(content), bytes: content.length },
      content
    });
  }

  const manifest: WorkspaceManifest = {
    version: "fusionkit.manifest.v1",
    baseRef,
    bundleHash: sha256Hex(bundle),
    ...(dirtyDiff ? { dirtyDiffHash: sha256Hex(dirtyDiff) } : {}),
    untrackedFiles: untracked.map((u) => u.file),
    deniedPatterns: denyPatterns,
    deniedPaths
  };

  return { manifest, bundle, dirtyDiff, untracked };
}

export type BlobFetcher = (hash: string) => Promise<Buffer>;

/** Recreate the captured workspace inside a fresh session directory. */
export async function materializeWorkspace(
  sessionDir: string,
  manifest: WorkspaceManifest,
  fetchBlob: BlobFetcher
): Promise<string> {
  mkdirSync(sessionDir, { recursive: true });
  const bundlePath = join(sessionDir, "workspace.bundle");
  writeFileSync(bundlePath, await fetchBlob(manifest.bundleHash));

  const repoDir = join(sessionDir, "repo");
  git(sessionDir, ["clone", "--quiet", bundlePath, repoDir]);
  git(repoDir, ["checkout", "--quiet", manifest.baseRef]);

  if (manifest.dirtyDiffHash) {
    const diffPath = join(sessionDir, "dirty.patch");
    writeFileSync(diffPath, await fetchBlob(manifest.dirtyDiffHash));
    git(repoDir, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
  }

  for (const file of manifest.untrackedFiles) {
    const rel = parseWorkspaceRelativePath(file.path);
    const content = await fetchBlob(file.hash);
    if (sha256Hex(content) !== file.hash) {
      throw new Error(`blob hash mismatch for ${file.path}`);
    }
    const target = resolveInsideWorkspace(repoDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return repoDir;
}

export type WorkspaceOutput = {
  diff: Buffer;
  changedFiles: { path: string; contentHash: string }[];
};

/** Collect the session's output as a binary diff against the base ref. */
export function collectOutput(repoDir: string, baseRef: string): WorkspaceOutput {
  git(repoDir, ["add", "-A"]);
  const diff = gitBinary(repoDir, ["diff", "--binary", "--cached", baseRef]);
  const changed = git(repoDir, ["diff", "--name-only", "--cached", baseRef])
    .split("\n")
    .filter((line) => line.length > 0);
  const changedFiles = changed.map((path) => {
    const rel = parseWorkspaceRelativePath(path);
    const full = resolveInsideWorkspace(repoDir, rel);
    try {
      statSync(full);
      return { path: rel, contentHash: sha256Hex(readFileSync(full)) };
    } catch {
      return { path: rel, contentHash: DELETED_FILE_HASH };
    }
  });
  return { diff, changedFiles };
}

export type PullResult =
  | { mode: "applied" }
  | { mode: "branch"; branch: string }
  | { mode: "empty" };

export type PullOptions = {
  /** Always land results on a dedicated branch; never touch the checkout. */
  forceBranch?: boolean;
  /** Branch name prefix for branch-mode pulls. Defaults to "fusionkit/". */
  branchPrefix?: string;
  /** Committer identity for the branch-mode commit. */
  committer?: { name: string; email: string };
};

/**
 * Divergence-safe pull: apply the run's output diff directly only when the
 * local workspace is clean and still at the contract's base ref; otherwise
 * materialize the result on a dedicated branch and leave the checkout alone.
 */
export function pullRun(
  repoDir: string,
  runId: string,
  baseRef: string,
  outDiff: Buffer,
  options: PullOptions = {}
): PullResult {
  if (outDiff.length === 0) return { mode: "empty" };

  const head = git(repoDir, ["rev-parse", "HEAD"]).trim();
  const dirty = git(repoDir, ["status", "--porcelain"]).trim().length > 0;
  const diffPath = join(
    mkdtempSync(join(tmpdir(), "fusionkit-pull-")),
    "out.patch"
  );
  writeFileSync(diffPath, outDiff);

  if (!options.forceBranch && head === baseRef && !dirty) {
    git(repoDir, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
    rmSync(dirname(diffPath), { recursive: true, force: true });
    return { mode: "applied" };
  }

  const shortId = runId.replace(/^run_/, "").slice(0, 12);
  const branch = `${options.branchPrefix ?? PULL_BRANCH_PREFIX}${shortId}`;
  const committer = options.committer ?? DEFAULT_PULL_COMMITTER;
  const worktree = mkdtempSync(join(tmpdir(), "fusionkit-worktree-"));
  try {
    git(repoDir, ["worktree", "add", "--detach", worktree, baseRef]);
    git(worktree, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
    git(worktree, ["add", "-A"]);
    git(worktree, [
      "-c",
      `user.name=${committer.name}`,
      "-c",
      `user.email=${committer.email}`,
      "commit",
      "--quiet",
      "-m",
      `fusionkit run ${runId}`
    ]);
    const commit = git(worktree, ["rev-parse", "HEAD"]).trim();
    git(repoDir, ["branch", "-f", branch, commit]);
  } finally {
    git(repoDir, ["worktree", "remove", "--force", worktree], true);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(dirname(diffPath), { recursive: true, force: true });
  }
  return { mode: "branch", branch };
}
