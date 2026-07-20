/**
 * Product-agnostic daemonizer.
 *
 * `startDaemon` turns a foreground `serve`-style CLI invocation into a
 * background service: the child runs detached in its own process group with
 * stdout/stderr appended to a rotated `<home>/logs/<kind>.log`, the start
 * critical section is file-locked so concurrent starts cannot race, and the
 * call only returns once the child has written its service record and its
 * `/health` endpoint answers. Unlike `superviseSpawn` children, a daemon is
 * deliberately NOT registered with the cleanup registry — it must outlive the
 * CLI that started it.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { definedEnv } from "../environment.js";
import { distillLog, sleep, tryAcquireFileLock } from "../index.js";

import { createServiceRecordStore, processAlive, SERVICE_SUPERVISOR_ENV } from "./records.js";
import type { ServiceRecord, ServiceSupervisorKind } from "./records.js";

export type ServiceDaemonSpec = {
  product: string;
  kind: string;
  /** Product state home (e.g. `~/.routekit`); records and logs live under it. */
  home: string;
  /** Version of the CLI starting the daemon (for skew reporting only). */
  version?: string;
  /** The foreground serve invocation to detach. */
  command: { execPath: string; args: readonly string[] };
  cwd?: string;
  /**
   * Daemon environment. Defaults to the full parent environment: the daemon
   * runs in the caller's own trust domain and needs the caller's provider
   * credentials, so the child-allowlist used for harness children would be
   * wrong here.
   */
  env?: Record<string, string | undefined>;
  /** Stamped into the child env so its record names the supervisor. */
  supervisor?: ServiceSupervisorKind;
  log?: (line: string) => void;
};

export type StartDaemonOptions = {
  /** How long to wait for the record + healthy `/health` (default 30s). */
  readyTimeoutMs?: number;
  /**
   * A pid the new daemon replaces: an existing live record with this pid is
   * ignored instead of short-circuiting to "already running" (blue-green).
   */
  previousPid?: number;
};

export type StartDaemonResult = {
  alreadyRunning: boolean;
  record: ServiceRecord;
  logFile: string;
};

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 150;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_TAIL_BYTES = 64 * 1024;

export function serviceLogPath(home: string, kind: string): string {
  return join(home, "logs", `${kind}.log`);
}

/** Size-based rotation: `<kind>.log` -> `.1` -> `.2` -> ... up to `keep`. */
export function rotateLogFile(
  path: string,
  options: { maxBytes?: number; keep?: number } = {}
): void {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = options.keep ?? LOG_KEEP;
  if (!existsSync(path)) return;
  try {
    if (statSync(path).size < maxBytes) return;
    rmSync(`${path}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    }
    renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best-effort; a daemon must still start when it fails.
  }
}

/** The last `maxBytes` of a log file, or empty when unreadable. */
export function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): string {
  try {
    const size = statSync(path).size;
    const descriptor = openSync(path, "r");
    try {
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return "";
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(50);
  }
  return !processAlive(pid);
}

async function healthOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function startFailure(label: string, reason: string, logFile: string): Error {
  const tail = distillLog(readLogTail(logFile));
  return new Error(
    `${label} ${reason}${tail.length > 0 ? `\n${tail}` : ""}\n(full log: ${logFile})`
  );
}

/**
 * Wait until a service record for `kind` exists (from a pid other than
 * `previousPid`, when given) and its loopback `/health` answers. Shared by the
 * daemonizer and supervisor installs, where the spawning is done by the init
 * system instead of us.
 */
export async function waitForServiceReady(input: {
  home: string;
  product: string;
  kind: string;
  timeoutMs?: number;
  previousPid?: number;
  /** Fails fast when the process being awaited is already gone. */
  expectPid?: () => number | undefined;
  logFile?: string;
  label?: string;
}): Promise<ServiceRecord> {
  const store = createServiceRecordStore({ home: input.home, product: input.product });
  const label = input.label ?? `${input.product} ${input.kind}`;
  const logFile = input.logFile ?? serviceLogPath(input.home, input.kind);
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let lastState = "no service record yet";
  while (Date.now() < deadline) {
    const expected = input.expectPid?.();
    if (input.expectPid !== undefined && expected === undefined) {
      throw startFailure(label, "exited before becoming ready", logFile);
    }
    const record = store.read(input.kind);
    if (record !== undefined && record.pid !== input.previousPid) {
      if (await healthOk(`http://127.0.0.1:${record.port}`)) return record;
      lastState = `pid ${record.pid} is not answering /health on port ${record.port}`;
    }
    await sleep(READY_POLL_MS);
  }
  throw startFailure(
    label,
    `did not become ready within ${input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms (${lastState})`,
    logFile
  );
}

export async function startDaemon(
  spec: ServiceDaemonSpec,
  options: StartDaemonOptions = {}
): Promise<StartDaemonResult> {
  const store = createServiceRecordStore({ home: spec.home, product: spec.product });
  const logFile = serviceLogPath(spec.home, spec.kind);
  const label = `${spec.product} ${spec.kind}`;

  const existing = store.read(spec.kind);
  if (existing !== undefined && existing.pid !== options.previousPid) {
    return { alreadyRunning: true, record: existing, logFile };
  }

  mkdirSync(store.directory, { recursive: true, mode: 0o700 });
  const lockPath = join(store.directory, `${spec.kind}.lock`);
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let lock = tryAcquireFileLock(lockPath);
  while (lock === undefined) {
    // Another CLI is starting the same daemon: wait for its record instead of
    // racing it, but reclaim the lock if that starter died mid-flight.
    const record = store.read(spec.kind);
    if (record !== undefined && record.pid !== options.previousPid) {
      return { alreadyRunning: true, record, logFile };
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} start is locked by another process (${lockPath})`);
    }
    await sleep(READY_POLL_MS);
    lock = tryAcquireFileLock(lockPath);
  }

  try {
    mkdirSync(join(spec.home, "logs"), { recursive: true, mode: 0o700 });
    rotateLogFile(logFile);
    const descriptor = openSync(logFile, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command.execPath, [...spec.command.args], {
        detached: true,
        stdio: ["ignore", descriptor, descriptor],
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        env: {
          ...definedEnv(spec.env ?? process.env),
          [SERVICE_SUPERVISOR_ENV]: spec.supervisor ?? "detached"
        }
      });
    } finally {
      closeSync(descriptor);
    }
    let spawnError: Error | undefined;
    let exited = false;
    child.once("error", (error) => (spawnError = error));
    child.once("exit", () => (exited = true));
    child.unref();

    try {
      const record = await waitForServiceReady({
        home: spec.home,
        product: spec.product,
        kind: spec.kind,
        timeoutMs: Math.max(0, deadline - Date.now()),
        ...(options.previousPid !== undefined ? { previousPid: options.previousPid } : {}),
        expectPid: () =>
          spawnError !== undefined || exited ? undefined : child.pid,
        logFile,
        label
      });
      spec.log?.(`${label} started (pid ${record.pid})`);
      return { alreadyRunning: false, record, logFile };
    } catch (error) {
      // A child that never became ready must not linger half-started.
      if (child.pid !== undefined && !exited) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // already gone
          }
        }
      }
      if (spawnError !== undefined) {
        throw startFailure(label, `failed to start: ${spawnError.message}`, logFile);
      }
      throw error;
    }
  } finally {
    lock.release();
  }
}

export type StopDaemonResult = {
  stopped: boolean;
  /** The process did not exit within the grace and was SIGKILLed. */
  forced: boolean;
};

/**
 * Stop a recorded daemon process: SIGTERM its process group (falling back to
 * the pid), wait up to `graceMs` for the drain-and-exit, then SIGKILL. The
 * grace must cover the service's drain window or in-flight work is severed.
 */
export async function stopDaemonProcess(
  record: Pick<ServiceRecord, "pid">,
  options: { graceMs?: number } = {}
): Promise<StopDaemonResult> {
  const graceMs = options.graceMs ?? 35_000;
  if (record.pid === process.pid || !processAlive(record.pid)) {
    return { stopped: false, forced: false };
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-record.pid, signal);
    } catch {
      try {
        process.kill(record.pid, signal);
      } catch {
        // already gone
      }
    }
  };
  signalGroup("SIGTERM");
  if (await waitForProcessExit(record.pid, graceMs)) return { stopped: true, forced: false };
  signalGroup("SIGKILL");
  await waitForProcessExit(record.pid, 2_000);
  return { stopped: true, forced: true };
}
