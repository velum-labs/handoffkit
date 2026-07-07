/**
 * Signal/cleanup integration acceptance (WS7): SIGINT during a live run with a
 * fake long-running harness leaves no worktrees, no .git/worktrees
 * registrations, and no orphaned harness processes.
 *
 * The scenario runs in a child fixture process (installing SIGINT handlers in
 * the test runner would be invasive): the fixture creates a real worktree plan
 * against a scratch repo, registers its cleanup with the cleanup registry,
 * launches a fake harness through the process supervisor, then hangs until the
 * test SIGINTs it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKTREE_MODULE = fileURLToPath(new URL("../worktree.js", import.meta.url));
const CLEANUP_MODULE = fileURLToPath(new URL("../../../runtime-utils/dist/cleanup.js", import.meta.url));
const PROCESS_MODULE = fileURLToPath(new URL("../../../runtime-utils/dist/process.js", import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@fusionkit.dev"]);
  git(dir, ["config", "user.name", "FusionKit Test"]);
  writeFileSync(join(dir, "README.md"), "scratch\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("SIGINT mid-run cleans worktrees, registrations, and the harness process group", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "fusionkit-signal-cleanup-"));
  const repo = join(scratch, "repo");
  makeRepo(repo);
  try {
    const fixture = join(scratch, "fixture.mjs");
    writeFileSync(
      fixture,
      `
import { createWorktreePlan, cleanupWorktreePlan } from ${JSON.stringify(WORKTREE_MODULE)};
import { registerCleanup } from ${JSON.stringify(CLEANUP_MODULE)};
import { superviseSpawn } from ${JSON.stringify(PROCESS_MODULE)};

const plan = createWorktreePlan({
  id: "sigint_case",
  workspace: ${JSON.stringify(repo)},
  models: [{ id: "modelA" }, { id: "modelB" }],
  task: "noop"
});
registerCleanup(() => {
  cleanupWorktreePlan(plan);
});
// The fake long-running harness: a child that would outlive the run if the
// supervisor did not tie its lifetime to the cleanup registry.
const harness = superviseSpawn("sleep", ["600"]);
console.log(JSON.stringify({ ready: true, root: plan.root, harnessPid: harness.pid }));
setInterval(() => {}, 1000);
`
    );

    const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "inherit"] });
    const readyInfo = await new Promise<{ root: string; harnessPid: number }>((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered.split("\n").find((candidate) => candidate.includes("ready"));
        if (line !== undefined) resolve(JSON.parse(line) as { root: string; harnessPid: number });
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error("fixture exited before signaling ready")));
    });

    // Live state exists before the signal: two worktrees plus the harness.
    assert.equal(readdirSync(readyInfo.root).length, 2);
    assert.equal(processAlive(readyInfo.harnessPid), true);
    assert.match(git(repo, ["worktree", "list"]), /sigint_case/);

    child.removeAllListeners("exit");
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    child.kill("SIGINT");
    const exitCode = await exited;
    assert.equal(exitCode, 130);

    // No worktree directories, no .git/worktrees registrations, no orphaned
    // harness process.
    assert.equal(existsSync(readyInfo.root), false);
    assert.doesNotMatch(git(repo, ["worktree", "list"]), /sigint_case/);
    const registrations = join(repo, ".git", "worktrees");
    if (existsSync(registrations)) {
      assert.deepEqual(readdirSync(registrations), []);
    }
    const deadline = Date.now() + 5_000;
    while (processAlive(readyInfo.harnessPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processAlive(readyInfo.harnessPid), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
