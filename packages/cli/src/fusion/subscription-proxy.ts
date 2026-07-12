/**
 * Lifecycle for the long-lived `fusionkit proxy` daemon. The proxy is a real
 * background process the user starts once; this module is the one place that
 * knows how to record it, discover it, and stop it, so no command pokes at the
 * filesystem or process table directly.
 *
 * Two layers, mirroring the rest of the stack:
 * - A private state record (`~/.fusionkit/subscriptions/proxy.json`, 0600) is
 *   the source of truth for the ingress token and owning pid — it is what makes
 *   discovery work even when portless is unavailable (Node < 24 / no proxy).
 * - When portless is active the listener also registers a stable
 *   `subscriptions.fusion.localhost` route, so `fusionkit stop`
 *   (`reapFusionServices`) reaps it like every other fusion service.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createPortlessSession, reapService } from "../shared/portless.js";

/** The portless service name (`subscriptions.fusion.localhost`). */
export const SUBSCRIPTION_PROXY_SERVICE = "subscriptions";

/** State directory (honoring `FUSIONKIT_SUBSCRIPTIONS_DIR` for tests). */
function stateRoot(): string {
  return process.env.FUSIONKIT_SUBSCRIPTIONS_DIR ?? join(homedir(), ".fusionkit", "subscriptions");
}

function statePath(): string {
  return join(stateRoot(), "proxy.json");
}

export type SubscriptionProxyState = {
  token: string;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readState(): SubscriptionProxyState | undefined {
  const path = statePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SubscriptionProxyState;
  } catch {
    return undefined;
  }
}

function writeState(state: SubscriptionProxyState): void {
  const path = statePath();
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function clearState(): void {
  rmSync(statePath(), { force: true });
}

/** A registration handle returned to `proxy serve` for teardown on shutdown. */
export type RegisteredProxy = {
  /** The URL to advertise (portless name when active, else loopback). */
  url: string;
  release(): Promise<void>;
};

/**
 * Record a just-started proxy: persist its state record and, when portless is
 * active, register the stable route. Returns the advertised URL and a `release`
 * that unregisters the route and clears the record on shutdown.
 */
export async function registerRunningProxy(input: {
  loopbackUrl: string;
  port: number;
  token: string;
  portless?: boolean;
  log?: (line: string) => void;
}): Promise<RegisteredProxy> {
  const session = await createPortlessSession({
    enabled: input.portless ?? true,
    ...(input.log !== undefined ? { log: input.log } : {})
  });
  const url = session.enabled
    ? session.register(SUBSCRIPTION_PROXY_SERVICE, input.port)
    : input.loopbackUrl;
  writeState({
    token: input.token,
    pid: process.pid,
    url,
    port: input.port,
    startedAt: new Date().toISOString()
  });
  return {
    url,
    release: async () => {
      if (session.enabled) session.unregister(SUBSCRIPTION_PROXY_SERVICE);
      clearState();
    }
  };
}

/** The running proxy (state record + liveness), or undefined when not running. */
export function discoverProxy(): SubscriptionProxyState | undefined {
  const state = readState();
  if (state === undefined) return undefined;
  if (!isAlive(state.pid)) {
    clearState();
    return undefined;
  }
  return state;
}

export type StopProxyResult = { stopped: boolean; pid?: number; stale?: boolean };

/**
 * Stop the running proxy: drop its portless route (so `fusionkit stop` and this
 * agree), signal the owning pid, and clear the state record. Idempotent.
 */
export async function stopProxy(log?: (line: string) => void): Promise<StopProxyResult> {
  const state = readState();
  const reaped = await reapService(SUBSCRIPTION_PROXY_SERVICE, log);
  if (state === undefined) return { stopped: reaped };
  let stopped = reaped;
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
      stopped = true;
    } catch {
      // already gone
    }
  }
  clearState();
  return stopped ? { stopped: true, pid: state.pid } : { stopped: false, stale: true };
}
