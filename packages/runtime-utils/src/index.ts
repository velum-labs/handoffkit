import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";

type EnvInput = Record<string, string | undefined>;

export const RUNTIME_TIMEOUT_MS = {
  remoteTool: 5 * 60 * 1000,
  sandboxCommand: 5 * 60 * 1000,
  session: 10 * 60 * 1000,
  panelModel: 10 * 60 * 1000
} as const;

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

/**
 * True when `command` resolves to an executable: an existing path when it
 * contains a separator, else a match on any `PATH` entry (with Windows
 * `PATHEXT` extensions appended). One implementation shared by every harness
 * and launcher instead of three subtly-different copies.
 */
export function commandOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry.length > 0)
      : [""];
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((dir) =>
      exts.some((ext) => existsSync(join(dir, ext.length > 0 ? `${command}${ext}` : command)))
    );
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

export function definedEnv(env: EnvInput): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Strip trailing "/" characters in linear time (a `/\/+$/` regex backtracks
 * polynomially on adversarial input, which code scanning rightly flags).
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * System variables every spawned CLI legitimately needs: process resolution,
 * home/config discovery, temp dirs, locale, terminal, TLS trust, and proxies.
 * Deliberately excludes every credential-shaped variable — those must be
 * allowlisted per harness via {@link buildChildEnv}.
 */
const BASELINE_CHILD_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows process resolution and config discovery.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES"
];

const BASELINE_CHILD_ENV_PATTERNS: readonly RegExp[] = [/^LC_/, /^XDG_/];

export type BuildChildEnvInput = {
  /** Source environment (defaults to `process.env`). */
  base?: Record<string, string | undefined>;
  /** Harness-specific names or patterns forwarded in addition to the baseline. */
  allow?: readonly (string | RegExp)[];
  /** Explicit values set unconditionally (win over `base`). */
  extra?: Record<string, string>;
};

/**
 * Build a child environment from an explicit allowlist instead of spreading
 * the entire parent environment: a harness CLI driven headlessly must not
 * inherit every credential the parent process happens to hold. The baseline
 * covers system plumbing (PATH/HOME/locale/TLS/proxy); everything else must be
 * named by the caller.
 */
export function buildChildEnv(input: BuildChildEnvInput = {}): Record<string, string> {
  const base = input.base ?? process.env;
  const names = new Set<string>(BASELINE_CHILD_ENV_NAMES);
  const patterns: RegExp[] = [...BASELINE_CHILD_ENV_PATTERNS];
  for (const entry of input.allow ?? []) {
    if (typeof entry === "string") names.add(entry);
    else patterns.push(entry);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (names.has(key) || patterns.some((pattern) => pattern.test(key))) {
      result[key] = value;
    }
  }
  Object.assign(result, input.extra ?? {});
  return result;
}

export const DEFAULT_BRIDGE_SCRUB_PREFIXES = [
  "BRIDGE_",
  "MODEL_",
  "CURSOR_UPSTREAM"
] as const;

export function scrubBridgeEnv(
  env: EnvInput,
  prefixes: readonly string[] = DEFAULT_BRIDGE_SCRUB_PREFIXES
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
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

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await probeEphemeralPort();
    if (!recentlyReserved.has(port)) {
      reserve(port);
      return port;
    }
  }
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
        terminate(child, options.graceMs);
      }, options.timeoutMs);
    }
    const onAbort = (): void => {
      aborted = true;
      abortReason = signal !== undefined ? abortReasonText(signal) : "aborted";
      terminate(child, options.graceMs);
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
      env: { ...process.env, ...env },
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
