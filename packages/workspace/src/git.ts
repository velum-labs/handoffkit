import { spawnSync } from "node:child_process";

/**
 * Shared git invocation used across capture, materialization, pull, the
 * test fixtures, and the compute adapter. `git` is a hard runtime
 * dependency of this package by design — its entire job is git workspace
 * capture — so a missing or failing git surfaces as a clear error rather
 * than a swallowed condition.
 */

/** Upper bound on captured git output (bundles/diffs can be large). */
export const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export type GitOptions = {
  /** Return stdout even on non-zero exit instead of throwing. */
  allowFail?: boolean;
  maxBuffer?: number;
};

function fail(args: string[], detail: string): never {
  throw new Error(`git ${args.join(" ")} failed: ${detail}`);
}

/** Run git and return stdout as text. */
export function gitText(cwd: string, args: string[], options: GitOptions = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER_BYTES
  });
  if (result.error) {
    fail(args, result.error.message);
  }
  if (result.status !== 0 && !options.allowFail) {
    fail(args, result.stderr || result.stdout || `exit ${result.status}`);
  }
  return result.stdout;
}

/** Run git and return stdout as raw bytes (for bundles and binary diffs). */
export function gitBinary(cwd: string, args: string[], options: GitOptions = {}): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER_BYTES
  });
  if (result.error) {
    fail(args, result.error.message);
  }
  if (result.status !== 0 && !options.allowFail) {
    fail(args, result.stderr.toString() || `exit ${result.status}`);
  }
  return result.stdout;
}
