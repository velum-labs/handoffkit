import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { sha256Hex } from "../protocol/hash.js";
import {
  captureWorkspace,
  collectOutput,
  materializeWorkspace,
  matchesPattern,
  pullRun
} from "../runner/workspace.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "warrant-test-repo-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@warrant.local"]);
  git(dir, ["config", "user.name", "warrant-test"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  writeFileSync(join(dir, "src.txt"), "original\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "init"]);
  return dir;
}

test("glob matching", () => {
  assert.equal(matchesPattern(".env", ".env"), true);
  assert.equal(matchesPattern("config/.env.local", ".env.*"), true);
  assert.equal(matchesPattern("keys/server.pem", "*.pem"), true);
  assert.equal(matchesPattern("notes.md", "*.pem"), false);
  assert.equal(matchesPattern("a/b/c.txt", "a/**"), true);
});

test("capture denies secrets, includes allowlisted untracked, records denials", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "src.txt"), "modified\n");
    writeFileSync(join(repo, "notes.md"), "untracked notes\n");
    writeFileSync(join(repo, ".env"), "SECRET=do-not-capture\n");

    const captured = captureWorkspace(repo, { allowUntracked: ["*.md"] });

    assert.equal(captured.manifest.untrackedFiles.length, 1);
    assert.equal(captured.manifest.untrackedFiles[0]?.path, "notes.md");
    assert.deepEqual(captured.manifest.deniedPaths, [".env"]);
    assert.ok(captured.dirtyDiff, "uncommitted change should produce a diff");
    assert.ok(captured.manifest.dirtyDiffHash);

    const bundleText = captured.bundle.toString("latin1");
    assert.ok(!bundleText.includes("do-not-capture"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("materialize reproduces the captured workspace; output diff round-trips", async () => {
  const repo = makeRepo();
  const sessionDir = mkdtempSync(join(tmpdir(), "warrant-test-session-"));
  try {
    writeFileSync(join(repo, "src.txt"), "modified\n");
    writeFileSync(join(repo, "notes.md"), "untracked notes\n");
    const captured = captureWorkspace(repo, { allowUntracked: ["*.md"] });

    const blobs = new Map<string, Buffer>();
    blobs.set(sha256Hex(captured.bundle), captured.bundle);
    if (captured.dirtyDiff) {
      blobs.set(sha256Hex(captured.dirtyDiff), captured.dirtyDiff);
    }
    for (const file of captured.untracked) {
      blobs.set(file.file.hash, file.content);
    }

    const materialized = await materializeWorkspace(
      sessionDir,
      captured.manifest,
      (hash) => {
        const blob = blobs.get(hash);
        if (!blob) throw new Error(`missing blob ${hash}`);
        return Promise.resolve(blob);
      }
    );

    assert.equal(readFileSync(join(materialized, "src.txt"), "utf8"), "modified\n");
    assert.equal(
      readFileSync(join(materialized, "notes.md"), "utf8"),
      "untracked notes\n"
    );

    writeFileSync(join(materialized, "agent-output.txt"), "made by agent\n");
    const output = collectOutput(materialized, captured.manifest.baseRef);
    assert.ok(output.diff.length > 0);
    const paths = output.changedFiles.map((f) => f.path).sort();
    assert.deepEqual(paths, ["agent-output.txt", "notes.md", "src.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("pull applies cleanly at base ref and branches on divergence", () => {
  const repo = makeRepo();
  try {
    const baseRef = git(repo, ["rev-parse", "HEAD"]).trim();

    const diff = Buffer.from(
      [
        "diff --git a/pulled.txt b/pulled.txt",
        "new file mode 100644",
        "index 0000000..7e55434",
        "--- /dev/null",
        "+++ b/pulled.txt",
        "@@ -0,0 +1 @@",
        "+pulled content",
        ""
      ].join("\n"),
      "utf8"
    );

    const clean = pullRun(repo, "run_clean", baseRef, diff);
    assert.deepEqual(clean, { mode: "applied" });
    assert.equal(readFileSync(join(repo, "pulled.txt"), "utf8"), "pulled content\n");

    // Diverge: commit something else, then pull again.
    writeFileSync(join(repo, "diverged.txt"), "local work\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "local divergence"]);

    const diverged = pullRun(repo, "run_diverged123", baseRef, diff);
    assert.equal(diverged.mode, "branch");
    if (diverged.mode === "branch") {
      const branches = git(repo, ["branch", "--list", diverged.branch]).trim();
      assert.ok(branches.includes(diverged.branch));
      const show = git(repo, ["show", `${diverged.branch}:pulled.txt`]);
      assert.equal(show, "pulled content\n");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
