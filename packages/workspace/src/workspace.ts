import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";

import { sha256Hex } from "@warrant/protocol";
import type { ManifestFile, WorkspaceManifest } from "@warrant/protocol";

export const DEFAULT_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*"
];

// TODO(lib): suggest simple-git or isomorphic-git — raw spawnSync git
// TODO(brittle): raw spawnSync git, no version/path checks
function git(cwd: string, args: string[], allowFail = false): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // TODO(hardcoded): git maxBuffer 256MB
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function gitBinary(cwd: string, args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout;
}

/** Minimal glob: `**` crosses directories, `*` within a segment, `?` one char. */
// TODO(lib): suggest minimatch/micromatch — glob
// TODO(brittle): custom minimal glob
export function matchesPattern(path: string, pattern: string): boolean {
  const target = pattern.includes("/") ? path : path.split("/").pop() ?? path;
  const regex = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) =>
          piece
            .split("?")
            .map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]")
        )
        .join("[^/]*")
    )
    .join(".*");
  return new RegExp(`^${regex}$`).test(target);
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
  const denyPatterns = options.denyPatterns ?? DEFAULT_DENY_PATTERNS;
  const allowUntracked = options.allowUntracked ?? [];

  const baseRef = git(repoDir, ["rev-parse", "HEAD"]).trim();

  const bundlePath = join(
    mkdtempSync(join(tmpdir(), "warrant-bundle-")),
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
    if (denyPatterns.some((pattern) => matchesPattern(path, pattern))) {
      deniedPaths.push(path);
      continue;
    }
    if (!allowUntracked.some((pattern) => matchesPattern(path, pattern))) {
      continue;
    }
    const content = readFileSync(join(repoDir, path));
    untracked.push({
      file: { path, hash: sha256Hex(content), bytes: content.length },
      content
    });
  }

  const manifest: WorkspaceManifest = {
    version: "warrant.manifest.v1",
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
    const content = await fetchBlob(file.hash);
    if (sha256Hex(content) !== file.hash) {
      throw new Error(`blob hash mismatch for ${file.path}`);
    }
    const target = join(repoDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return repoDir;
}

export type WorkspaceOutput = {
  diff: Buffer;
  changedFiles: { path: string; contentHash: string }[];
};

// TODO(hardcoded): DELETED_HASH
const DELETED_HASH = "0".repeat(64);

/** Collect the session's output as a binary diff against the base ref. */
export function collectOutput(repoDir: string, baseRef: string): WorkspaceOutput {
  git(repoDir, ["add", "-A"]);
  const diff = gitBinary(repoDir, ["diff", "--binary", "--cached", baseRef]);
  const changed = git(repoDir, ["diff", "--name-only", "--cached", baseRef])
    .split("\n")
    .filter((line) => line.length > 0);
  const changedFiles = changed.map((path) => {
    const full = join(repoDir, path);
    try {
      statSync(full);
      return { path, contentHash: sha256Hex(readFileSync(full)) };
    } catch {
      return { path, contentHash: DELETED_HASH };
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
    mkdtempSync(join(tmpdir(), "warrant-pull-")),
    "out.patch"
  );
  writeFileSync(diffPath, outDiff);

  if (!options.forceBranch && head === baseRef && !dirty) {
    git(repoDir, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
    rmSync(dirname(diffPath), { recursive: true, force: true });
    return { mode: "applied" };
  }

  const shortId = runId.replace(/^run_/, "").slice(0, 12);
  // TODO(hardcoded): branch prefix warrant/
  const branch = `warrant/${shortId}`;
  const worktree = mkdtempSync(join(tmpdir(), "warrant-worktree-"));
  try {
    git(repoDir, ["worktree", "add", "--detach", worktree, baseRef]);
    git(worktree, ["apply", "--binary", "--whitespace=nowarn", diffPath]);
    git(worktree, ["add", "-A"]);
    // TODO(hardcoded): pull git identity
    git(worktree, [
      "-c",
      "user.name=warrant",
      "-c",
      "user.email=warrant@localhost",
      "commit",
      "--quiet",
      "-m",
      `warrant run ${runId}`
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
