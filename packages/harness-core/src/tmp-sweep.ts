import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A crash-safe registry of temp directories a harness created (ephemeral CLI
 * homes, worktrees). Each is recorded before use and removed on normal
 * cleanup; anything still recorded at the next process start is swept, so a
 * crash between creation and cleanup cannot leak dirs (or credentials) in
 * /tmp forever.
 */
export const DEFAULT_TMP_MANIFEST = join(homedir(), ".routekit", "tmp-manifest.json");

type ManifestEntry = { path: string; createdAt: string };

function readManifest(manifestPath: string): ManifestEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries?: ManifestEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeManifest(manifestPath: string, entries: ManifestEntry[]): void {
  try {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify({ entries }, null, 2)}\n`);
  } catch {
    // Best-effort: a manifest write failure must not break the run.
  }
}

/** Create a tracked temp dir under `tmpdir()`, recorded in the manifest. */
export function createTrackedTmpDir(
  prefix: string,
  manifestPath: string = DEFAULT_TMP_MANIFEST
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const entries = readManifest(manifestPath);
  entries.push({ path: dir, createdAt: new Date().toISOString() });
  writeManifest(manifestPath, entries);
  return dir;
}

/** Remove a tracked temp dir and drop it from the manifest. */
export function releaseTrackedTmpDir(
  dir: string,
  manifestPath: string = DEFAULT_TMP_MANIFEST
): void {
  rmSync(dir, { recursive: true, force: true });
  writeManifest(
    manifestPath,
    readManifest(manifestPath).filter((entry) => entry.path !== dir)
  );
}

/**
 * Remove every temp dir still recorded in the manifest (leaked by a prior
 * crash) and clear it. Returns the paths swept. Call once at CLI start.
 */
export function sweepTrackedTmpDirs(manifestPath: string = DEFAULT_TMP_MANIFEST): string[] {
  const entries = readManifest(manifestPath);
  const swept: string[] = [];
  for (const entry of entries) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      swept.push(entry.path);
    } catch {
      // Leave un-sweepable paths for a later attempt.
    }
  }
  writeManifest(manifestPath, []);
  return swept;
}
