import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { createServer } from "node:net";

/** Shared process helpers for the CLI's launcher/gateway flows and tool packages. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ports we have handed out very recently but whose child may not have bound
// yet. Holding them out of circulation for a short window closes the race where
// two concurrent `freePort()` callers (parallel server startup) receive the
// same number between the probe socket closing and the child binding.
const recentlyReserved = new Map<number, NodeJS.Timeout>();
const RESERVATION_MS = 5000;

function reserve(port: number): void {
  const existing = recentlyReserved.get(port);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => recentlyReserved.delete(port), RESERVATION_MS);
  timer.unref();
  recentlyReserved.set(port, timer);
}

/**
 * Reserve an ephemeral loopback port and return it. The probe socket is closed
 * before returning (children bind it themselves), but the number is held out of
 * circulation briefly so concurrent callers do not collide. Retries a bounded
 * number of times if the OS hands back a number we just reserved.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await probeEphemeralPort();
    if (!recentlyReserved.has(port)) {
      reserve(port);
      return port;
    }
  }
  // Extremely unlikely; fall back to whatever the OS last offered.
  const port = await probeEphemeralPort();
  reserve(port);
  return port;
}

function probeEphemeralPort(): Promise<number> {
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

/** Keep at most this many bytes of a child's captured output in memory. */
const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

export type LoggedSpawnOptions = SpawnOptions & {
  /** Tee the child's full stdout+stderr to this path for post-mortem. */
  logFile?: string;
  /** Cap the in-memory ring buffer (default 256 KiB). */
  maxLogBytes?: number;
};

/**
 * A spawned background child with captured output and a recorded spawn error.
 * Always attaches an `'error'` listener so a missing binary surfaces as a clear
 * message via {@link waitForHttp} instead of crashing the process. The captured
 * log is a bounded ring buffer (so long sessions cannot leak memory); the full,
 * untruncated output is written to `logFile` when one is provided.
 */
export type LoggedChild = {
  child: ChildProcess;
  /** The most recent captured stdout+stderr, up to the ring-buffer cap. */
  log: () => string;
  /** The spawn `'error'` (e.g. ENOENT), if one was emitted. */
  spawnError: () => Error | undefined;
  /** The full log file path, when teeing was requested. */
  logFile: () => string | undefined;
  /** Flush and close the log file stream (best-effort). */
  closeLog: () => void;
};

export function spawnLogged(
  command: string,
  args: string[],
  options: LoggedSpawnOptions = {}
): LoggedChild {
  const { logFile, maxLogBytes, ...spawnOptions } = options;
  const cap = maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  // `detached: true` makes the child its own process-group leader so that
  // `terminate()` can signal the whole tree. This matters for wrappers like
  // `uvx` (uvx -> uv -> python): signalling only the immediate child would
  // orphan the grandchildren. Output is still piped; we never `unref()`, so the
  // parent keeps managing the child's lifecycle.
  const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let spawnError: Error | undefined;
  let file: WriteStream | undefined;
  if (logFile !== undefined) {
    try {
      file = createWriteStream(logFile, { flags: "a" });
      // A broken log sink must never crash the run.
      file.on("error", () => {});
    } catch {
      file = undefined;
    }
  }
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    file?.write(text);
    buffer += text;
    if (buffer.length > cap) buffer = buffer.slice(buffer.length - cap);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", (error: Error) => (spawnError = error));
  return {
    child,
    log: () => buffer,
    spawnError: () => spawnError,
    logFile: () => logFile,
    closeLog: () => {
      try {
        file?.end();
      } catch {
        // already closed
      }
    }
  };
}

/**
 * Distill the most useful slice of captured output for an error message. Prefers
 * lines that look like errors (so the root cause is not buried under `uvx`
 * resolve/build noise), then falls back to the head and tail of the log. The
 * full log lives in the child's `logFile` when one was provided.
 */
export function distillLog(raw: string, options: { maxLines?: number } = {}): string {
  const maxLines = options.maxLines ?? 16;
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  const errorPattern =
    /error|exception|traceback|fatal|denied|unauthorized|forbidden|invalid|not found|refused|timed? ?out|missing|failed|panic|429|401|403|500/i;
  const errorLines = lines.filter((line) => errorPattern.test(line));
  if (errorLines.length > 0) {
    return errorLines.slice(-maxLines).join("\n");
  }
  if (lines.length <= maxLines) return lines.join("\n");
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, "...", ...tail].join("\n");
}

function failureDetail(proc: LoggedChild): string {
  const distilled = distillLog(proc.log());
  const logPath = proc.logFile();
  const pathNote = logPath !== undefined ? `\n(full log: ${logPath})` : "";
  return `${distilled}${pathNote}`;
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
      throw new Error(`${options.label} failed to start: ${spawnError.message}\n${failureDetail(proc)}`);
    }
    if (proc.child.exitCode !== null) {
      throw new Error(
        `${options.label} exited (code ${proc.child.exitCode}) before becoming ready\n${failureDetail(proc)}`
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
    `${options.label} did not become ready within ${options.timeoutMs}ms (${lastError})\n${failureDetail(proc)}`
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
      reject(new Error(`${options.label} did not start within ${options.timeoutMs}ms:\n${failureDetail(proc)}`));
    }, options.timeoutMs);
    const poll = setInterval(() => {
      if (proc.spawnError() !== undefined) {
        cleanup();
        reject(new Error(`${options.label} failed to start: ${proc.spawnError()?.message}\n${failureDetail(proc)}`));
      } else if (pattern.test(proc.log())) {
        cleanup();
        resolve();
      }
    }, 100);
    const onExit = (): void => {
      cleanup();
      reject(new Error(`${options.label} exited before becoming ready:\n${failureDetail(proc)}`));
    };
    proc.child.once("exit", onExit);
    function cleanup(): void {
      clearTimeout(deadline);
      clearInterval(poll);
      proc.child.off("exit", onExit);
    }
  });
}

/**
 * SIGTERM a child's whole process group, escalating to SIGKILL if it ignores the
 * grace period. Killing the group (`process.kill(-pid, ...)`) tears down wrapper
 * trees like `uvx -> uv -> python`; if the child was not spawned detached (no
 * group), it falls back to signalling the child directly.
 */
export function terminate(child: ChildProcess, graceMs = 5000): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
