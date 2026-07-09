/**
 * How the Node testkit reaches the Python side: everything runs through `uv`
 * against the repo's committed uv workspace, exactly like a developer (and the
 * production CLI's `fusionkitDir` dev override) does.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The monorepo root (this package lives at `<root>/packages/testkit`). */
export function repoRoot(): string {
  const override = process.env.FUSIONKIT_TESTKIT_ROOT;
  if (override !== undefined && override.length > 0) return override;
  // dist/python.js -> packages/testkit -> packages -> <root>
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export type StackTooling =
  | { available: true }
  | { available: false; reason: string };

/**
 * Whether the Python side of the stack tooling is usable here. Tests gate on
 * this so environments without `uv` (or with the tooling explicitly disabled
 * via FUSIONKIT_E2E_STACK=0) skip with an honest reason instead of failing.
 */
export function detectStackTooling(): StackTooling {
  if (process.env.FUSIONKIT_E2E_STACK === "0") {
    return { available: false, reason: "disabled via FUSIONKIT_E2E_STACK=0" };
  }
  const probe = spawnSync("uv", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    return { available: false, reason: "uv is not on PATH (the Python workspace tooling)" };
  }
  return { available: true };
}

/**
 * `node:test` skip-gating sugar: `test("...", { skip: stackToolingSkip() }, ...)`
 * runs where the Python toolchain is available and skips with the honest
 * reason everywhere else.
 */
export function stackToolingSkip(): false | string {
  const tooling = detectStackTooling();
  return tooling.available ? false : `stack tooling unavailable: ${tooling.reason}`;
}

/** argv for `uv run --package <pkg> <entrypoint> ...args`, run from the repo root. */
export function uvRunArgv(pkg: string, entrypoint: string, args: readonly string[]): {
  command: string;
  args: string[];
  cwd: string;
} {
  return {
    command: "uv",
    args: ["run", "--package", pkg, entrypoint, ...args],
    cwd: repoRoot()
  };
}
