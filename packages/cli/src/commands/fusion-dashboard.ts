/**
 * `fusionkit fusion dashboard` — launch the scope routing dashboard and open a browser.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";

import { findScopeAppDir, openUrl, SCOPE_DASHBOARD_PORT } from "../fusion/observability.js";
import {
  resolveRoutingDashboardUrl,
  resolveRoutingScopeIngestUrl
} from "../fusion/routing-decision-publisher.js";
import { sleep } from "../shared/proc.js";
import { parsePort } from "../shared/options.js";

export type FusionDashboardOptions = {
  port?: number;
  noOpen?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
  sleepMs?: (ms: number) => Promise<void>;
};

/**
 * Resolve the scope dashboard URL, honouring `FUSION_ROUTING_SCOPE_URL` and `--port`.
 */
export function resolveFusionDashboardUrl(
  env: NodeJS.ProcessEnv = process.env,
  port?: number
): string {
  return resolveRoutingDashboardUrl(env, port);
}

/**
 * Resolve the decisions API URL used for readiness checks.
 */
export function resolveFusionDashboardHealthUrl(
  env: NodeJS.ProcessEnv = process.env,
  port?: number
): string {
  return resolveRoutingScopeIngestUrl(env, port);
}

/**
 * Check whether the scope dashboard is already serving on the given port.
 */
export async function isScopeDashboardUp(
  healthUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1000;
  try {
    const response = await fetchFn(healthUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok || response.status === 405;
  } catch {
    return false;
  }
}

/**
 * Spawn `pnpm --filter scope dev` detached from the monorepo root.
 */
export function spawnScopeDev(
  options: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv; port?: number } = {}
): { pid: number | undefined; monorepoRoot: string } {
  const spawnFn = options.spawnImpl ?? spawn;
  const scopeDir = findScopeAppDir();
  const monorepoRoot = dirname(dirname(scopeDir));
  const port = options.port ?? SCOPE_DASHBOARD_PORT;
  const child = spawnFn("pnpm", ["--filter", "scope", "dev"], {
    cwd: monorepoRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...options.env, PORT: String(port) }
  });
  child.unref();
  return { pid: child.pid, monorepoRoot };
}

/**
 * Poll until the scope dashboard responds or the timeout elapses.
 */
export async function waitForScopeDashboard(
  healthUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    intervalMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
  } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 500;
  const sleepFn = options.sleepMs ?? sleep;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isScopeDashboardUp(healthUrl, { fetchImpl: options.fetchImpl })) return true;
    await sleepFn(intervalMs);
  }
  return false;
}

/**
 * Run `fusionkit fusion dashboard`.
 */
export async function runFusionDashboard(options: FusionDashboardOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const sleepFn = options.sleepMs ?? sleep;
  const port = options.port;
  const dashboardUrl = resolveFusionDashboardUrl(env, port);
  const healthUrl = resolveFusionDashboardHealthUrl(env, port);

  if (!(await isScopeDashboardUp(healthUrl, { fetchImpl: options.fetchImpl }))) {
    const { pid } = spawnScopeDev({
      ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
      env,
      ...(port !== undefined ? { port } : {})
    });
    if (pid !== undefined) {
      log(`fusion: started scope dev (pid ${pid})`);
    }
    const ready = await waitForScopeDashboard(healthUrl, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      sleepMs: sleepFn
    });
    if (!ready) {
      console.error("error: scope dashboard did not become ready within 15s");
      console.error("  try manually: cd apps/scope && pnpm dev");
      return 1;
    }
  }

  log(`🌐 Opening ${dashboardUrl}`);
  if (options.noOpen !== true) {
    openUrl(dashboardUrl);
  }
  return 0;
}

/**
 * Parse the `--port` flag for `fusion dashboard`.
 */
export function parseDashboardPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parsePort(value, SCOPE_DASHBOARD_PORT);
}
