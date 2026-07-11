/**
 * Process supervisor (WS7.1).
 *
 * `superviseSpawn` is the lifecycle-correct spawn primitive every harness child
 * should use: the child runs in its own detached process group, its env is
 * built through {@link buildChildEnv} (an allowlist, never a raw `process.env`
 * inherit), and kill/abort/timeout terminate the WHOLE group with a
 * SIGTERM -> SIGKILL escalation — so a CLI that spawns its own subprocesses
 * cannot leave orphans. Each supervised child is also registered with the
 * cleanup registry so a crash or interrupt group-kills it too, and unregistered
 * once it exits.
 */
import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { EventEmitter } from "node:events";

import { registerCleanup } from "./cleanup.js";
import { buildChildEnv } from "./index.js";

/** SIGTERM -> SIGKILL escalation grace default (ms). */
const DEFAULT_GRACE_MS = 5_000;

export type ExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
};

export interface Spawned {
  pid: number;
  child: ChildProcess;
  done: Promise<ExitInfo>;
  kill(sig?: NodeJS.Signals): void;
}

export type SuperviseSpawnOptions = {
  cwd?: string;
  /** Explicit env wins verbatim; otherwise built via {@link buildChildEnv}. */
  env?: Record<string, string>;
  /** Names/patterns forwarded on top of the baseline (see buildChildEnv). */
  envAllow?: Array<string | RegExp>;
  /** Values injected unconditionally on top of the allowlist. */
  extraEnv?: Record<string, string>;
  /** Kills the whole group on abort; the exit is marked `aborted`. */
  signal?: AbortSignal;
  /** SIGTERMs the whole group after this long; the exit is marked `timedOut`. */
  timeoutMs?: number;
  /** SIGTERM -> SIGKILL escalation grace (default 5000ms). */
  graceMs?: number;
  stdio?: StdioOptions;
};

/**
 * Terminate a child's whole process group with a SIGTERM -> SIGKILL escalation.
 * The negative-pid `process.kill(-pid, ...)` targets the group leader's group
 * (the child was spawned `detached`); if that fails (already gone, or no group)
 * we fall back to killing the child directly. Shared by {@link superviseSpawn}
 * and `runCliCapture` so both escalate identically.
 */
export function terminateGroup(
  child: ChildProcess,
  graceMs = DEFAULT_GRACE_MS,
  initialSignal: NodeJS.Signals = "SIGTERM"
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const send = (sig: NodeJS.Signals): void => {
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
  send(initialSignal);
  const timer = setTimeout(() => send("SIGKILL"), graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

function preAborted(): Spawned {
  // The signal was already aborted, so nothing is spawned: return a settled
  // handle. `child`/`pid` are inert placeholders — callers of the pre-aborted
  // path only observe `done`.
  const child = new EventEmitter() as unknown as ChildProcess;
  return {
    pid: -1,
    child,
    done: Promise.resolve({ exitCode: null, signal: null, timedOut: false, aborted: true }),
    kill: () => {}
  };
}

export function superviseSpawn(
  command: string,
  args: readonly string[],
  opts: SuperviseSpawnOptions = {}
): Spawned {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const signal = opts.signal;
  if (signal?.aborted === true) return preAborted();

  const env =
    opts.env ?? buildChildEnv({ allow: opts.envAllow ?? [], extra: opts.extraEnv ?? {} });
  const child = spawn(command, [...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    detached: true,
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"]
  });

  let timedOut = false;
  let aborted = false;

  const done = new Promise<ExitInfo>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child, graceMs);
      }, opts.timeoutMs);
    }
    const onAbort = (): void => {
      aborted = true;
      terminateGroup(child, graceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A supervised child that outlives the run (crash/interrupt) is group-killed
    // by the cleanup registry; the registration is dropped once it exits.
    const unregister = registerCleanup(() => terminateGroup(child, graceMs));
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unregister();
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, sig) => {
      cleanup();
      resolve({ exitCode: code, signal: sig, timedOut, aborted });
    });
  });

  return {
    pid: child.pid ?? -1,
    child,
    done,
    kill: (sig?: NodeJS.Signals) => terminateGroup(child, graceMs, sig ?? "SIGTERM")
  };
}
