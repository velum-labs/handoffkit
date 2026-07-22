/**
 * OS supervision adapters.
 *
 * Persistence across crashes and reboots is delegated to the platform's init
 * supervisor instead of reimplementing supervision: a systemd **user** unit on
 * Linux (`Restart=always`, lingering enabled so it survives logout/reboot) or
 * a launchd agent on macOS (`KeepAlive` + `RunAtLoad`). Unit/plist generation
 * is pure (spec in, file content out) so it is testable without an init
 * system; the side-effecting install/uninstall/status calls go through an
 * injectable {@link CommandRunner} seam for the same reason. When neither
 * supervisor is available (containers, WSL without a systemd user session),
 * callers fall back to the plain detached daemon.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { runCliCapture, writeFileAtomic } from "../index.js";

import { SERVICE_SUPERVISOR_ENV } from "./records.js";

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (command, args, options) => {
  const result = await runCliCapture(command, [...args], {
    timeoutMs: options?.timeoutMs ?? 30_000
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

export type ServiceUnitSpec = {
  product: string;
  kind: string;
  description: string;
  /** The foreground serve invocation the supervisor keeps alive. */
  command: { execPath: string; args: readonly string[] };
  workingDirectory?: string;
  /** Non-secret environment baked into the unit/plist. */
  env?: Record<string, string>;
  /**
   * Secrets file (0600, outside the unit) referenced via `EnvironmentFile=`.
   * systemd only; launchd has no equivalent, so secrets go into `env` there
   * and the plist itself is written 0600.
   */
  environmentFile?: string;
  /** launchd stdout/stderr destination (systemd logs to the journal). */
  logFile?: string;
  /** Stop grace; the supervisor must not SIGKILL mid-drain. */
  drainGraceMs?: number;
};

export type SupervisorStatus = {
  installed: boolean;
  active: boolean;
  detail?: string;
};

export type SupervisorController = {
  kind: "systemd" | "launchd";
  unitName: string;
  unitPath: string;
  /** Write the unit, enable it, and start it now. */
  install(spec: ServiceUnitSpec): Promise<void>;
  /** Stop, disable, and remove the unit. Returns false when not installed. */
  uninstall(options?: { timeoutMs?: number }): Promise<boolean>;
  start(options?: { timeoutMs?: number }): Promise<void>;
  stop(options?: { timeoutMs?: number }): Promise<void>;
  restart(options?: { timeoutMs?: number }): Promise<void>;
  status(): Promise<SupervisorStatus>;
};

const STOP_MARGIN_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

function stopTimeoutSeconds(drainGraceMs: number | undefined): number {
  return Math.ceil(((drainGraceMs ?? 30_000) + STOP_MARGIN_MS) / 1000);
}

export function supervisorOperationTimeoutMs(drainGraceMs: number | undefined): number {
  return (drainGraceMs ?? 30_000) + STOP_MARGIN_MS + 10_000;
}

// ---- systemd (Linux user unit) ----

export function systemdUnitName(product: string, kind: string): string {
  return `${product}-${kind}.service`;
}

export function systemdUnitPath(product: string, kind: string, home = homedir()): string {
  return join(home, ".config", "systemd", "user", systemdUnitName(product, kind));
}

/** Quote one ExecStart argument per systemd.service quoting rules. */
function systemdQuote(argument: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(argument) && argument.length > 0) return argument;
  return `"${argument.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function assertSafeEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid environment variable name: ${name}`);
  }
}

export function systemdServiceUnit(spec: ServiceUnitSpec): string {
  const execStart = [spec.command.execPath, ...spec.command.args]
    .map(systemdQuote)
    .join(" ");
  const lines = [
    "[Unit]",
    `Description=${spec.description}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=2",
    `TimeoutStopSec=${stopTimeoutSeconds(spec.drainGraceMs)}`,
    `Environment=${systemdQuote(`${SERVICE_SUPERVISOR_ENV}=systemd`)}`
  ];
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    assertSafeEnvName(name);
    lines.push(`Environment=${systemdQuote(`${name}=${value}`)}`);
  }
  if (spec.environmentFile !== undefined) {
    // The leading "-" tolerates a missing file so the service still starts.
    lines.push(`EnvironmentFile=-${spec.environmentFile}`);
  }
  if (spec.workingDirectory !== undefined) {
    lines.push(`WorkingDirectory=${spec.workingDirectory}`);
  }
  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

function runnerError(
  label: string,
  result: { exitCode: number; stdout: string; stderr: string }
): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return new Error(`${label} failed (exit ${result.exitCode})${detail.length > 0 ? `: ${detail}` : ""}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSystemdController(input: {
  product: string;
  kind: string;
  runner: CommandRunner;
  home?: string;
}): SupervisorController {
  const unitName = systemdUnitName(input.product, input.kind);
  const unitPath = systemdUnitPath(input.product, input.kind, input.home);
  const runner = input.runner;
  const systemctl = async (
    args: readonly string[],
    label: string,
    options?: { timeoutMs?: number }
  ): Promise<void> => {
    const result = await runner("systemctl", ["--user", ...args], options);
    if (result.exitCode !== 0) throw runnerError(label, result);
  };
  return {
    kind: "systemd",
    unitName,
    unitPath,
    async install(spec) {
      const prior = await runner("systemctl", ["--user", "is-active", unitName]);
      const wasActive = prior.exitCode === 0 && prior.stdout.trim() === "active";
      const timeoutMs = supervisorOperationTimeoutMs(spec.drainGraceMs);
      mkdirSync(join(unitPath, ".."), { recursive: true });
      writeFileAtomic(unitPath, systemdServiceUnit(spec), { mode: 0o600 });
      chmodSync(unitPath, 0o600);
      await systemctl(["daemon-reload"], "systemctl daemon-reload");
      // Lingering keeps the user manager (and this service) alive without an
      // open session, i.e. across logout and reboot. Best-effort: it can
      // require privileges on hardened hosts, and the service still runs for
      // the current session without it.
      await runner("loginctl", ["enable-linger", userInfo().username]);
      await systemctl(["enable", unitName], `systemctl enable ${unitName}`);
      await systemctl(
        [wasActive ? "restart" : "start", unitName],
        `systemctl ${wasActive ? "restart" : "start"} ${unitName}`,
        { timeoutMs }
      );
    },
    async uninstall(options) {
      if (!existsSync(unitPath)) return false;
      await systemctl(
        ["disable", "--now", unitName],
        `systemctl disable --now ${unitName}`,
        options
      );
      rmSync(unitPath, { force: true });
      await systemctl(["daemon-reload"], "systemctl daemon-reload");
      return true;
    },
    async start(options) {
      await systemctl(["start", unitName], `systemctl start ${unitName}`, options);
    },
    async stop(options) {
      await systemctl(["stop", unitName], `systemctl stop ${unitName}`, options);
    },
    async restart(options) {
      await systemctl(["restart", unitName], `systemctl restart ${unitName}`, options);
    },
    async status() {
      const installed = existsSync(unitPath);
      const result = await runner("systemctl", ["--user", "is-active", unitName]);
      const detail = result.stdout.trim();
      return {
        installed,
        active: result.exitCode === 0 && detail === "active",
        ...(detail.length > 0 ? { detail } : {})
      };
    }
  };
}

// ---- launchd (macOS agent) ----

export function launchdLabel(product: string, kind: string): string {
  return `com.${product}.${kind}`;
}

export function launchdPlistPath(product: string, kind: string, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(product, kind)}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function launchdAgentPlist(spec: ServiceUnitSpec): string {
  const label = launchdLabel(spec.product, spec.kind);
  const programArguments = [spec.command.execPath, ...spec.command.args]
    .map((argument) => `      <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const env: Record<string, string> = {
    [SERVICE_SUPERVISOR_ENV]: "launchd",
    ...spec.env
  };
  const envEntries = Object.entries(env)
    .map(([name, value]) => {
      assertSafeEnvName(name);
      return `      <key>${xmlEscape(name)}</key>\n      <string>${xmlEscape(value)}</string>`;
    })
    .join("\n");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${xmlEscape(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    programArguments,
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ExitTimeOut</key>",
    `    <integer>${stopTimeoutSeconds(spec.drainGraceMs)}</integer>`,
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    envEntries,
    "    </dict>"
  ];
  if (spec.workingDirectory !== undefined) {
    lines.push(
      "    <key>WorkingDirectory</key>",
      `    <string>${xmlEscape(spec.workingDirectory)}</string>`
    );
  }
  if (spec.logFile !== undefined) {
    lines.push(
      "    <key>StandardOutPath</key>",
      `    <string>${xmlEscape(spec.logFile)}</string>`,
      "    <key>StandardErrorPath</key>",
      `    <string>${xmlEscape(spec.logFile)}</string>`
    );
  }
  lines.push("  </dict>", "</plist>", "");
  return lines.join("\n");
}

function createLaunchdController(input: {
  product: string;
  kind: string;
  runner: CommandRunner;
  home?: string;
  uid?: number;
}): SupervisorController {
  const label = launchdLabel(input.product, input.kind);
  const unitPath = launchdPlistPath(input.product, input.kind, input.home);
  const uid = input.uid ?? process.getuid?.() ?? 0;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${label}`;
  const runner = input.runner;
  const launchctl = async (
    args: readonly string[],
    label_: string,
    options?: { timeoutMs?: number }
  ): Promise<void> => {
    const result = await runner("launchctl", args, options);
    if (result.exitCode !== 0) throw runnerError(label_, result);
  };
  const bootstrap = async (options?: { timeoutMs?: number }): Promise<void> => {
    const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    for (let attempt = 0; ; attempt += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const result = await runner(
        "launchctl",
        ["bootstrap", domainTarget, unitPath],
        { timeoutMs: remainingMs }
      );
      if (result.exitCode === 0) return;
      const detail = `${result.stderr}\n${result.stdout}`;
      const transient =
        result.exitCode === 5 || /Bootstrap failed:\s*5(?:\D|$)/i.test(detail);
      const retryDelay = LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      if (!transient || retryDelay === undefined || Date.now() + retryDelay >= deadline) {
        throw runnerError(`launchctl bootstrap ${label}`, result);
      }
      // bootout may return before launchd has fully retired the old service.
      // Back off and require bootstrap itself to confirm the replacement.
      await delay(retryDelay);
    }
  };
  return {
    kind: "launchd",
    unitName: label,
    unitPath,
    async install(spec) {
      mkdirSync(join(unitPath, ".."), { recursive: true });
      if (spec.logFile !== undefined) {
        mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
      }
      // The plist may embed secrets (launchd has no EnvironmentFile): 0600.
      writeFileAtomic(unitPath, launchdAgentPlist(spec), { mode: 0o600 });
      chmodSync(unitPath, 0o600);
      // Re-installs must bootout the previous instance first; ignore failures
      // when nothing was loaded.
      await runner("launchctl", ["bootout", serviceTarget]);
      await bootstrap({ timeoutMs: supervisorOperationTimeoutMs(spec.drainGraceMs) });
      await runner("launchctl", ["enable", serviceTarget]);
    },
    async uninstall(options) {
      if (!existsSync(unitPath)) return false;
      const active = await runner("launchctl", ["print", serviceTarget]);
      if (active.exitCode === 0) {
        await launchctl(
          ["bootout", serviceTarget],
          `launchctl bootout ${label}`,
          options
        );
      }
      rmSync(unitPath, { force: true });
      return true;
    },
    async start(options) {
      await bootstrap(options);
    },
    async stop(options) {
      // bootout (not `stop`): KeepAlive would immediately restart a stopped
      // service, so a stop must unload it until the next bootstrap.
      await launchctl(["bootout", serviceTarget], `launchctl bootout ${label}`, options);
    },
    async restart(options) {
      await launchctl(["bootout", serviceTarget], `launchctl bootout ${label}`, options);
      await bootstrap(options);
    },
    async status() {
      const installed = existsSync(unitPath);
      const result = await runner("launchctl", ["print", serviceTarget]);
      return { installed, active: result.exitCode === 0 };
    }
  };
}

/**
 * Controller for a known supervisor kind (e.g. from a service record's
 * `supervisor` stamp). Use {@link detectSupervisor} when the platform's
 * supervisor is not known yet.
 */
export function supervisorController(
  kind: "systemd" | "launchd",
  product: string,
  service: string,
  options: { runner?: CommandRunner; home?: string; uid?: number } = {}
): SupervisorController {
  const runner = options.runner ?? defaultRunner;
  const scoped = {
    product,
    kind: service,
    runner,
    ...(options.home !== undefined ? { home: options.home } : {})
  };
  return kind === "systemd"
    ? createSystemdController(scoped)
    : createLaunchdController({
        ...scoped,
        ...(options.uid !== undefined ? { uid: options.uid } : {})
      });
}

// ---- detection ----

export type DetectSupervisorOptions = {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  env?: Record<string, string | undefined>;
  /** Overrides for tests; production callers omit them. */
  home?: string;
  uid?: number;
};

/**
 * Resolve the platform's user-level supervisor for a service, or undefined
 * when none is usable (then the caller falls back to the detached daemon).
 * Linux requires a reachable systemd user manager — containers and some WSL
 * setups do not have one even when `systemctl` exists on PATH.
 */
export async function detectSupervisor(
  product: string,
  kind: string,
  options: DetectSupervisorOptions = {}
): Promise<SupervisorController | undefined> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const scoped = { product, kind, runner, ...(options.home !== undefined ? { home: options.home } : {}) };
  if (platform === "darwin") {
    try {
      const probe = await runner("launchctl", ["version"]);
      if (probe.exitCode !== 0) return undefined;
    } catch {
      return undefined;
    }
    return createLaunchdController({
      ...scoped,
      ...(options.uid !== undefined ? { uid: options.uid } : {})
    });
  }
  if (platform === "linux") {
    try {
      const probe = await runner("systemctl", ["--user", "is-system-running"]);
      const state = probe.stdout.trim();
      // `is-system-running` exits non-zero for "degraded" (some unit failed)
      // although the manager is perfectly usable; only a connection failure
      // (empty/"offline" output) means there is no user manager to talk to.
      if (state.length === 0 || state === "offline" || /Failed to connect/i.test(probe.stderr)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return createSystemdController(scoped);
  }
  return undefined;
}
