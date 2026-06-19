import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createServer } from "node:net";

/** Shared process helpers for the CLI's launcher/gateway flows. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reserve an ephemeral loopback port and return it (closed before returning). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawn a foreground tool with inherited stdio and resolve with its exit code.
 * A spawn failure (e.g. binary not on PATH) rejects rather than emitting an
 * unhandled `error` event.
 */
export function spawnTool(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
      ...(cwd !== undefined ? { cwd } : {})
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

/**
 * A spawned background child with captured output and a recorded spawn error.
 * Always attaches an `'error'` listener so a missing binary surfaces as a clear
 * message via {@link waitForHttp} instead of crashing the process.
 */
export type LoggedChild = {
  child: ChildProcess;
  /** The combined stdout+stderr captured so far. */
  log: () => string;
  /** The spawn `'error'` (e.g. ENOENT), if one was emitted. */
  spawnError: () => Error | undefined;
};

export function spawnLogged(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): LoggedChild {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let spawnError: Error | undefined;
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.on("error", (error: Error) => (spawnError = error));
  return { child, log: () => log, spawnError: () => spawnError };
}

/**
 * Poll `probeUrl` until it answers (optionally requiring a 2xx), the child fails
 * to spawn, the child exits, or the timeout elapses. Distinguishes a failed
 * spawn ("uv: not found") from a slow start.
 */
export async function waitForHttp(
  probeUrl: string,
  proc: LoggedChild,
  options: { timeoutMs: number; label: string; requireOk?: boolean }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const spawnError = proc.spawnError();
    if (spawnError !== undefined) {
      throw new Error(`${options.label} failed to start: ${spawnError.message}\n${proc.log().slice(-500)}`);
    }
    if (proc.child.exitCode !== null) {
      throw new Error(
        `${options.label} exited (code ${proc.child.exitCode}) before becoming ready\n${proc.log().slice(-500)}`
      );
    }
    try {
      const response = await fetch(probeUrl);
      if (options.requireOk !== true || response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(
    `${options.label} did not become ready within ${options.timeoutMs}ms (${lastError})\n${proc.log().slice(-500)}`
  );
}

/** Resolve once `pattern` is seen on the child's output, or reject on exit/timeout. */
export function waitForOutput(
  proc: LoggedChild,
  pattern: RegExp,
  options: { timeoutMs: number; label: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`${options.label} did not start within ${options.timeoutMs}ms:\n${proc.log().slice(-500)}`));
    }, options.timeoutMs);
    const poll = setInterval(() => {
      if (proc.spawnError() !== undefined) {
        cleanup();
        reject(
          new Error(`${options.label} failed to start: ${proc.spawnError()?.message}\n${proc.log().slice(-500)}`)
        );
      } else if (pattern.test(proc.log())) {
        cleanup();
        resolve();
      }
    }, 100);
    const onExit = (): void => {
      cleanup();
      reject(new Error(`${options.label} exited before becoming ready:\n${proc.log().slice(-500)}`));
    };
    proc.child.once("exit", onExit);
    function cleanup(): void {
      clearTimeout(deadline);
      clearInterval(poll);
      proc.child.off("exit", onExit);
    }
  });
}

/** SIGTERM a child, escalating to SIGKILL if it ignores the grace period. */
export function terminate(child: ChildProcess, graceMs = 5000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
