/**
 * `fusionkit fusion dashboard` — launch the scope routing dashboard and open a browser.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  bundledScopeServer,
  findScopeAppDir,
  openUrl,
  SCOPE_DASHBOARD_PORT
} from "../fusion/observability.js";
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
  /** Override scope app location (tests only). */
  scopeDir?: string;
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
 * Manual start hint when the dashboard fails to become ready.
 */
export function scopeDashboardManualStartHint(scopeDir: string, port: number): string {
  const nextBin = join(scopeDir, "node_modules", ".bin", "next");
  if (existsSync(join(scopeDir, ".next", "BUILD_ID"))) {
    return `cd ${scopeDir} && ${nextBin} start -p ${port}`;
  }
  return `cd ${scopeDir} && pnpm install && pnpm dev:app`;
}

/**
 * Spawn the scope dashboard detached: prebuilt bundle when shipped, otherwise
 * `next build` (once) + `next start` from `apps/scope`.
 */
export function spawnScopeDev(
  options: {
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
    port?: number;
    log?: (line: string) => void;
    /** Override scope app location (tests only). */
    scopeDir?: string;
  } = {}
): { pid: number | undefined; monorepoRoot: string } {
  const spawnFn = options.spawnImpl ?? spawn;
  const scopeDir = options.scopeDir ?? findScopeAppDir();
  const monorepoRoot = dirname(dirname(scopeDir));
  const port = options.port ?? SCOPE_DASHBOARD_PORT;
  const childEnv = { ...process.env, ...options.env };

  const bundled = bundledScopeServer();
  if (bundled !== undefined) {
    const child = spawnFn(process.execPath, [bundled], {
      cwd: dirname(bundled),
      detached: true,
      stdio: "ignore",
      env: { ...childEnv, PORT: String(port), HOSTNAME: "127.0.0.1" }
    });
    child.unref();
    return { pid: child.pid, monorepoRoot };
  }

  const nextBin = join(scopeDir, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    throw new Error(
      "the dashboard is not available in this checkout.\n" +
        `  Install its dependencies once: cd ${scopeDir} && pnpm install`
    );
  }

  const alreadyBuilt = existsSync(join(scopeDir, ".next", "BUILD_ID"));
  if (!alreadyBuilt) {
    options.log?.("fusion: building scope dashboard (one-time)...");
    try {
      const buildOut = execFileSync(nextBin, ["build"], {
        cwd: scopeDir,
        env: childEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (buildOut.length > 0) options.log?.(buildOut.trimEnd());
    } catch (error) {
      const stdout = String((error as { stdout?: string }).stdout ?? "");
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      const detail = (stdout + stderr).trim();
      throw new Error(
        "the scope dashboard failed to build" + (detail.length > 0 ? `:\n${detail}` : "")
      );
    }
  }

  const child = spawnFn(nextBin, ["start", "-p", String(port)], {
    cwd: scopeDir,
    detached: true,
    stdio: "ignore",
    env: childEnv
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
    let scopeDir: string;
    try {
      scopeDir = findScopeAppDir();
    } catch {
      console.error("error: could not locate apps/scope for the routing dashboard");
      return 1;
    }

    try {
      const { pid } = spawnScopeDev({
        ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
        env,
        log,
        ...(port !== undefined ? { port } : {}),
        ...(options.scopeDir !== undefined ? { scopeDir: options.scopeDir } : {})
      });
      if (pid !== undefined) {
        log(`fusion: started scope dashboard (pid ${pid})`);
      }
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    const ready = await waitForScopeDashboard(healthUrl, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      sleepMs: sleepFn
    });
    if (!ready) {
      const hintPort = port ?? SCOPE_DASHBOARD_PORT;
      console.error("error: scope dashboard did not become ready within 15s");
      console.error(`  try manually: ${scopeDashboardManualStartHint(scopeDir, hintPort)}`);
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
