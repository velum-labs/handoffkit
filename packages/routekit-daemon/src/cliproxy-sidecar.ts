/**
 * Daemon-owned CLIProxyAPI sidecar.
 *
 * When the router config enables the `cliproxy` provider and the pinned
 * binary is installed under the RouteKit home, the daemon owns the sidecar
 * process: it starts it, restarts it after a crash, and stops it on daemon
 * shutdown. Users never run `cli-proxy-api` themselves. A self-managed
 * external proxy (ROUTEKIT_CLIPROXY_BASE_URL set) is never touched.
 */
import type { ChildProcess } from "node:child_process";

import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_PINNED_VERSION,
  cliproxyApiKey,
  cliproxyBaseUrl,
  cliproxyBinaryPath,
  spawnCliproxy
} from "@routekit/accounts";

const RESPAWN_DELAY_MS = 2_000;
const READY_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 5_000;

export type CliproxySidecar = {
  /** Start or stop the managed process to match the desired state. */
  reconcile(wanted: boolean): Promise<void>;
  running(): boolean;
  /** True when this daemon manages the sidecar process (not an external URL). */
  managed(): boolean;
  reachable(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
};

/** The sidecar is managed here unless an external proxy URL is configured. */
export function cliproxyManagedLocally(env: NodeJS.ProcessEnv): boolean {
  return (env[CLIPROXY_BASE_URL_ENV] ?? "").length === 0;
}

export function createCliproxySidecar(input: {
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): CliproxySidecar {
  const env = input.env;
  const log = input.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  let child: ChildProcess | undefined;
  let wanted = false;
  let closed = false;
  let respawnTimer: NodeJS.Timeout | undefined;

  const reachable = async (timeoutMs = 1_500): Promise<boolean> => {
    const key = env[CLIPROXY_API_KEY_ENV] ?? cliproxyApiKey(env) ?? "";
    try {
      // Any HTTP answer (including 401/403) proves the listener is up.
      await fetch(`${cliproxyBaseUrl(env)}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      return true;
    } catch {
      return false;
    }
  };

  const spawnOnce = (): void => {
    if (closed || !wanted || child !== undefined) return;
    let spawned: ChildProcess;
    try {
      spawned = spawnCliproxy(env, { stdio: "ignore" });
    } catch (error) {
      log(
        `routekit cliproxy sidecar failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    child = spawned;
    spawned.once("error", (error) => {
      log(`routekit cliproxy sidecar error: ${error.message}`);
    });
    spawned.once("exit", (code, signal) => {
      if (child === spawned) child = undefined;
      if (closed || !wanted) return;
      log(
        `routekit cliproxy sidecar exited (${signal ?? `code ${code ?? "unknown"}`}); restarting`
      );
      respawnTimer = setTimeout(() => {
        respawnTimer = undefined;
        spawnOnce();
      }, RESPAWN_DELAY_MS);
      respawnTimer.unref();
    });
  };

  const stop = async (): Promise<void> => {
    if (respawnTimer !== undefined) {
      clearTimeout(respawnTimer);
      respawnTimer = undefined;
    }
    const current = child;
    if (current === undefined) return;
    child = undefined;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        current.kill("SIGKILL");
      }, STOP_GRACE_MS);
      killTimer.unref();
      current.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      if (!current.kill("SIGTERM")) {
        clearTimeout(killTimer);
        resolve();
      }
    });
  };

  return {
    reconcile: async (next: boolean): Promise<void> => {
      if (closed) return;
      const installable =
        cliproxyManagedLocally(env) &&
        cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env) !== undefined;
      wanted = next && installable;
      if (!wanted) {
        await stop();
        return;
      }
      if (child !== undefined) return;
      spawnOnce();
      if (child === undefined) return;
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await reachable(READY_POLL_MS * 2)) return;
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }
      log("routekit cliproxy sidecar did not answer within its readiness window");
    },
    running: () => child !== undefined,
    managed: () => cliproxyManagedLocally(env),
    reachable,
    close: async (): Promise<void> => {
      closed = true;
      wanted = false;
      await stop();
    }
  };
}
