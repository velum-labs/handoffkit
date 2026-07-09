/**
 * Minimal observable child-process plumbing for the testkit: spawn with a
 * captured merged log, readiness probes that attach the child's own output to
 * failures, and graceful teardown. Self-contained on purpose — the testkit is
 * a leaf package so the packages under test can depend on it in their tests
 * without cycles.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export type SpawnedProcess = {
  child: ChildProcess;
  /** Everything the child printed so far (stdout + stderr, merged). */
  log: () => string;
  /** Resolves with the next line matching `pattern` (also scans buffered output). */
  nextLine: (pattern: RegExp, timeoutMs: number) => Promise<string>;
  close: () => Promise<void>;
};

export function spawnCaptured(input: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): SpawnedProcess {
  const child = spawn(input.command, input.args, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  const lineWaiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
  const scan = (): void => {
    for (let index = lineWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = lineWaiters[index];
      if (waiter === undefined) continue;
      const match = log.split("\n").find((line) => waiter.pattern.test(line));
      if (match !== undefined) {
        lineWaiters.splice(index, 1);
        waiter.resolve(match);
      }
    }
  };
  const append = (chunk: Buffer): void => {
    log += chunk.toString("utf8");
    scan();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    child,
    log: () => log,
    nextLine: (pattern, timeoutMs) =>
      new Promise<string>((resolvePromise, reject) => {
        const existing = log.split("\n").find((line) => pattern.test(line));
        if (existing !== undefined) {
          resolvePromise(existing);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${pattern} in child output:\n${log}`));
        }, timeoutMs);
        lineWaiters.push({
          pattern,
          resolve: (line) => {
            clearTimeout(timer);
            resolvePromise(line);
          }
        });
      }),
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
  };
}

/**
 * Poll `url` until it answers 200, failing fast (with the child's own log
 * attached) if the process exits first — a broken stack explains itself.
 */
export async function waitForHttpReady(
  url: string,
  proc: SpawnedProcess,
  input: { timeoutMs: number; label: string }
): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) {
      throw new Error(
        `${input.label} exited with code ${proc.child.exitCode} during startup\n--- log ---\n${proc.log()}`
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `${input.label} did not become ready within ${input.timeoutMs}ms\n--- log ---\n${proc.log()}`
  );
}

/** Pick a currently free TCP port (standard bind-and-release probe). */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
