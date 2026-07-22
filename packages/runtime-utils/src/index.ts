import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { WriteStream } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join, sep } from "node:path";

import { buildChildEnv } from "./environment.js";
import { terminateGroup } from "./process.js";
import { trimSurroundingSlashes } from "./url.js";

export { extendCleanupGrace, registerCleanup, runCleanups } from "./cleanup.js";
export {
  buildChildEnv,
  commandOnPath,
  DEFAULT_BRIDGE_SCRUB_PREFIXES,
  definedEnv,
  scrubBridgeEnv
} from "./environment.js";
export type { BuildChildEnvInput } from "./environment.js";
export { superviseSpawn, terminateGroup } from "./process.js";
export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process.js";
export {
  createActivePortlessSession,
  createPortlessSession,
  detectPortlessProxy,
  reapPortlessProject,
  reapPortlessService
} from "./portless.js";
export type {
  DetectedProxy,
  DiscoverOrSpawnInput,
  DiscoverOrSpawnResult,
  PortlessModule,
  PortlessOptions,
  PortlessSession,
  RouteMapping,
  RouteStoreLike,
  SpawnedService
} from "./portless.js";
export {
  createServiceRecordStore,
  processAlive,
  processIdentity,
  SERVICE_SUPERVISOR_ENV,
  supervisorFromEnv
} from "./service/records.js";
export type {
  ServiceRecord,
  ServiceRecordInput,
  ServiceRecordStore,
  ServiceSupervisorKind
} from "./service/records.js";
export {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  ControlError,
  controlTokenMatches,
  generateControlToken,
  startControlServer
} from "./service/control.js";
export type {
  ControlClientOptions,
  ControlErrorCode,
  ControlEvent,
  ControlFailure,
  ControlHandler,
  ControlHandlerContext,
  ControlRequest,
  ControlResponse,
  ControlSuccess,
  RunningControlServer
} from "./service/control.js";
export {
  acquireLifecycleLock,
  nextServiceGeneration
} from "./service/authority.js";
export type { LifecycleLock } from "./service/authority.js";
export {
  readLogTail,
  rotateLogFile,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  waitForProcessExit,
  waitForServiceReady
} from "./service/daemon.js";
export type {
  ServiceDaemonSpec,
  StartDaemonOptions,
  StartDaemonResult,
  StopDaemonResult
} from "./service/daemon.js";
export {
  detectSupervisor,
  launchdAgentPlist,
  launchdLabel,
  launchdPlistPath,
  supervisorController,
  supervisorOperationTimeoutMs,
  systemdServiceUnit,
  systemdUnitName,
  systemdUnitPath
} from "./service/supervisors.js";
export type {
  CommandRunner,
  DetectSupervisorOptions,
  ServiceUnitSpec,
  SupervisorController,
  SupervisorStatus
} from "./service/supervisors.js";
export { planUpgrade, upgradeDetachedDaemon } from "./service/upgrade.js";
export type {
  UpgradeDaemonInput,
  UpgradeDaemonResult,
  UpgradeStrategy
} from "./service/upgrade.js";
export {
  assertAuthenticatedBind,
  isLoopbackHost,
  normalizeApiBaseUrl,
  trimSurroundingSlashes,
  trimTrailingSlashes
} from "./url.js";

export const DEFAULT_RUNTIME_TIMEOUTS = {
  remoteTool: 5 * 60 * 1000,
  sandboxCommand: 5 * 60 * 1000,
  session: 10 * 60 * 1000
} as const;

/** Build a named timeout map in the product package that owns those names. */
export function defineTimeouts<const T extends Record<string, number>>(timeouts: T): Readonly<T> {
  return Object.freeze({ ...timeouts });
}

export const MANAGED_SERVER_DEFAULTS = {
  startupTimeoutMs: 120_000,
  idleShutdownMs: 5 * 60 * 1000,
  shutdownGraceMs: 5_000,
  healthPollMs: 250,
  outputTailBytes: 64 * 1024
} as const;

export const CANDIDATE_ISOLATION_DEFAULTS = {
  containerImage: "node:22",
  containerEngine: "docker",
  containerWorkdir: "/workspace",
  microvmProvider: "vercel-sandbox",
  microvmRuntime: "node24",
  unknownRuntimeDigest: "unknown"
} as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a compact random id (hex, no dashes) with an optional prefix. */
export function randomId(length = 10, prefix?: string): string {
  const id = randomUUID().replace(/-/g, "").slice(0, length);
  return prefix !== undefined ? `${prefix}${id}` : id;
}

/**
 * Rough token estimate from text (and optional tool/JSON payload strings):
 * minimum 1 token, ceil(chars / 4).
 */
export function estimateTokens(...texts: string[]): number {
  let chars = 0;
  for (const text of texts) chars += text.length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: Error) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${formatDurationMs(timeoutMs)}`);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The `git diff` of a working tree, or undefined when clean or not a repo. */
export function captureWorktreeDiff(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, "diff"], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    return result.status === 0 && stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create an output directory. When it lives under one of the caller-owned
 * data-directory segments, drop a self-ignoring `.gitignore` so generated
 * artifacts never pollute the user's working tree.
 */
export function ensureRunOutputDir(
  dir: string,
  options: { dataDirectoryNames?: readonly string[] } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const normalized = dir.split(sep).join("/");
  const inManagedDirectory = (options.dataDirectoryNames ?? []).some((name) => {
    const segment = trimSurroundingSlashes(name.split(sep).join("/"));
    return segment.length > 0 && (`/${normalized}/`).includes(`/${segment}/`);
  });
  if (inManagedDirectory) {
    const ignorePath = join(dir, ".gitignore");
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");
  }
  return dir;
}

/** Atomically replace a UTF-8 file by writing a sibling temporary first. */
export function writeFileAtomic(
  path: string,
  content: string,
  options: { mode?: number } = {}
): void {
  const temporary = `${path}.${process.pid}.${randomId(8)}.tmp`;
  try {
    writeFileSync(temporary, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {})
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type FileLock = { release(): void };

/**
 * Acquire an exclusive lock file. Creation is atomic; callers own retry policy
 * and must release the returned handle.
 */
export function tryAcquireFileLock(path: string): FileLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      closeSync(descriptor);
      rmSync(path, { force: true });
    }
  };
}

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
 * A held ephemeral port: the loopback listener stays open (so nothing else can
 * grab the port) until the caller `release()`s it — ideally immediately before
 * spawning the process that will bind it, which closes the classic
 * probe-then-close race where a returned port is stolen in the gap. The `server`
 * is exposed so a Node-side caller can adopt the already-bound listener instead
 * of releasing and re-binding.
 */
export type ReservedPort = {
  port: number;
  server: Server;
  release: () => Promise<void>;
};

/**
 * Bind (and hold) a free loopback port. Prefer this over {@link freePort} at any
 * bind site that can race: hold the reservation while preparing the child, then
 * `release()` right before the child binds.
 */
export async function reservePort(): Promise<ReservedPort> {
  for (let attempt = 0; ; attempt += 1) {
    const server = createServer();
    // The held listener must not keep the process alive on its own.
    server.unref();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    if (recentlyReserved.has(port) && attempt < 20) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      continue;
    }
    reserve(port);
    let released = false;
    const release = (): Promise<void> =>
      new Promise((resolve) => {
        if (released) {
          resolve();
          return;
        }
        released = true;
        server.close(() => resolve());
      });
    return { port, server, release };
  }
}

export async function freePort(): Promise<number> {
  const reserved = await reservePort();
  await reserved.release();
  return reserved.port;
}

export type CliCaptureOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** SIGTERM the process group after this long; exit code becomes 124. */
  timeoutMs?: number;
  /** Kills the process group on abort; exit code becomes 130. */
  signal?: AbortSignal;
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  /** Called once per complete stdout line (and once for a trailing partial line). */
  onStdoutLine?: (line: string) => void;
  /** SIGTERM -> SIGKILL escalation grace (default 5000ms). */
  graceMs?: number;
};

export type CliCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  abortReason?: string;
};

function abortReasonText(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined && reason !== null) return String(reason);
  return "aborted";
}

/**
 * Run a CLI to completion, capturing stdout/stderr, with the lifecycle rigor
 * every harness child needs: the child is spawned in its own process group and
 * timeout/abort kill the whole group with SIGTERM -> SIGKILL escalation, so a
 * CLI that spawns its own subprocesses (codex/claude/cursor all do) cannot
 * leave orphans behind. Rejects only on spawn failure (e.g. ENOENT); every
 * other outcome resolves. Exit codes mirror coreutils conventions: 124 for
 * timeout, 130 for abort.
 */
export function runCliCapture(
  command: string,
  args: string[],
  options: CliCaptureOptions = {}
): Promise<CliCaptureResult> {
  const signal = options.signal;
  if (signal?.aborted === true) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 130,
      timedOut: false,
      aborted: true,
      abortReason: abortReasonText(signal)
    });
  }
  return new Promise<CliCaptureResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      detached: true,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let pendingLine = "";
    let timedOut = false;
    let aborted = false;
    let abortReason: string | undefined;
    const flushLines = (final = false): void => {
      if (options.onStdoutLine === undefined) return;
      let newline = pendingLine.indexOf("\n");
      while (newline >= 0) {
        options.onStdoutLine(pendingLine.slice(0, newline));
        pendingLine = pendingLine.slice(newline + 1);
        newline = pendingLine.indexOf("\n");
      }
      if (final && pendingLine.length > 0) {
        options.onStdoutLine(pendingLine);
        pendingLine = "";
      }
    };
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child, options.graceMs);
      }, options.timeoutMs);
    }
    const onAbort = (): void => {
      aborted = true;
      abortReason = signal !== undefined ? abortReasonText(signal) : "aborted";
      terminateGroup(child, options.graceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {
        // The child may exit before consuming stdin (EPIPE); the exit handler
        // still settles the result.
      });
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (options.onStdoutLine !== undefined) {
        pendingLine += chunk.toString("utf8");
        flushLines();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code) => {
      cleanup();
      flushLines(true);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        // 124 mirrors coreutils `timeout`; 130 mirrors SIGINT-style interruption.
        exitCode: timedOut ? 124 : aborted ? 130 : code ?? 0,
        timedOut,
        aborted,
        ...(aborted ? { abortReason } : {})
      });
    });
  });
}

export function spawnTool(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: buildChildEnv({ extra: env }),
      ...(cwd !== undefined ? { cwd } : {})
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

export type LoggedSpawnOptions = SpawnOptions & {
  logFile?: string;
  maxLogBytes?: number;
};

export type LoggedChild = {
  child: ChildProcess;
  log: () => string;
  spawnError: () => Error | undefined;
  logFile: () => string | undefined;
  closeLog: () => void;
};

export function spawnLogged(
  command: string,
  args: string[],
  options: LoggedSpawnOptions = {}
): LoggedChild {
  const { logFile, maxLogBytes, ...spawnOptions } = options;
  const cap = maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let buffer = "";
  let spawnError: Error | undefined;
  let file: WriteStream | undefined;
  if (logFile !== undefined) {
    try {
      file = createWriteStream(logFile, { flags: "a" });
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

export function distillLog(raw: string, options: { maxLines?: number } = {}): string {
  const maxLines = options.maxLines ?? 16;
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  const errorPattern =
    /error|exception|traceback|fatal|denied|unauthorized|forbidden|invalid|not found|refused|timed? ?out|missing|failed|panic|429|401|403|500/i;
  const errorLines = lines.filter((line) => errorPattern.test(line));
  if (errorLines.length > 0) return errorLines.slice(-maxLines).join("\n");
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
 * SIGTERM -> SIGKILL a child's whole process group. Thin wrapper over
 * {@link terminateGroup} (the shared supervisor primitive) kept for the many
 * existing `terminate(child)` call sites.
 */
export function terminate(child: ChildProcess, graceMs = 5000): void {
  terminateGroup(child, graceMs);
}

export function escapeMarkdownCell(value: string): string {
  // Backslashes must be escaped first so pre-existing "\|" sequences in the
  // input cannot smuggle an unescaped cell delimiter through.
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`)
  ];
}
