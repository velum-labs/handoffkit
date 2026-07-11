/**
 * The local scope observability dashboard: locating the prebuilt bundle (or
 * building it from source in a monorepo checkout), starting it on the fixed
 * port, and exposing the trace URLs the orchestrator injects into spawned
 * children.
 */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnLogged, terminate, waitForHttp } from "../shared/proc.js";
import type { LoggedChild } from "../shared/proc.js";
import type { PortlessSession } from "../shared/portless.js";

import type { StackReporter } from "./env.js";

/** Fixed port for the local observability dashboard (the scope app). */
export const SCOPE_DASHBOARD_PORT = 4317;

/**
 * Locate the isolated scope dashboard app (handoffkit/apps/scope) by walking up
 * from this module. Works from both the compiled dist and src layouts. Only the
 * monorepo dev fallback uses this — published installs ship a prebuilt bundle.
 */
export function findScopeAppDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "apps", "scope");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate apps/scope relative to the handoffkit CLI");
}

/**
 * Path to the prebuilt, self-contained dashboard server staged into the CLI
 * package (`scope/server.js`, a sibling of `dist/`), or undefined when it is
 * absent — i.e. a monorepo dev checkout where the bundle was never staged. This
 * module compiles to `<cli-package>/dist/fusion/observability.js`, so the staged
 * bundle is two levels up at `<cli-package>/scope/server.js`.
 */
export function bundledScopeServer(): string | undefined {
  if (process.env.FUSIONKIT_DEV === "1") return undefined;
  const serverJs = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scope", "server.js");
  return existsSync(serverJs) ? serverJs : undefined;
}

const SCOPE_SOURCE_DIRECTORIES = ["app", "components", "lib"];
const SCOPE_SOURCE_FILES = [
  "components.json",
  "next.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "postcss.config.mjs",
  "tsconfig.json"
];
const SCOPE_BUILD_IDENTITY_FILE = "scope-dashboard-id";

export const SCOPE_BUNDLED_IDENTITY = "scope-dashboard:bundled";
export const SCOPE_DEV_SERVER_IDENTITY = "scope-dashboard:dev";

function addFileToHash(hash: ReturnType<typeof createHash>, scopeDir: string, file: string): void {
  hash.update(relative(scopeDir, file));
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}

function addDirectoryToHash(hash: ReturnType<typeof createHash>, scopeDir: string, dir: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      addDirectoryToHash(hash, scopeDir, child);
    } else if (entry.isFile()) {
      addFileToHash(hash, scopeDir, child);
    }
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function scopeSourceIdentity(scopeDir = findScopeAppDir()): string {
  const hash = createHash("sha256");
  for (const filename of SCOPE_SOURCE_FILES) {
    const file = join(scopeDir, filename);
    if (existsSync(file)) addFileToHash(hash, scopeDir, file);
  }
  for (const dirname of SCOPE_SOURCE_DIRECTORIES) {
    addDirectoryToHash(hash, scopeDir, join(scopeDir, dirname));
  }
  return `scope-dashboard:${hash.digest("hex").slice(0, 16)}`;
}

export function expectedScopeIdentity(): string {
  return bundledScopeServer() !== undefined ? SCOPE_BUNDLED_IDENTITY : scopeSourceIdentity();
}

/**
 * Inject the portless CA so spawned Node children (dashboard, cursor bridge,
 * launched agents) trust the proxy's HTTPS routes. Only `NODE_EXTRA_CA_CERTS` is
 * set: it *extends* Node's trust store. We deliberately do NOT set Python's
 * `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`, because those *replace* the bundle — and
 * pointing them at the portless CA alone breaks the router's outbound HTTPS to
 * real providers (api.openai.com, etc.). The router never calls a portless HTTPS
 * URL (providers go direct; MLX is loopback), so it needs no portless CA. If a
 * Python process ever must reach a portless HTTPS URL, build a combined
 * certifi+portless bundle rather than replacing the bundle here. A no-op when
 * portless is off (no CA path).
 */
function withCaEnv<T extends Record<string, string | undefined>>(
  env: T,
  caCertPath: string | undefined
): T {
  if (caCertPath === undefined) return env;
  return {
    ...env,
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? caCertPath
  };
}

/** Best-effort: open a URL in the default browser (no-op on failure). */
export function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // opening a browser is a convenience, never required
  }
}

export type Observability = {
  url: string;
  /** OTLP/HTTP traces endpoint (the scope collector's /api/ingest). */
  otlpUrl: string;
  close: () => Promise<void>;
};

/**
 * Spawn the prebuilt standalone dashboard server (`node scope/server.js`) on the
 * fixed port. The Next standalone entrypoint reads PORT/HOSTNAME from the env
 * (there is no `-p` flag). This is the path every npm-installed user takes.
 */
function startBundledDashboard(input: {
  serverJs: string;
  env: Record<string, string | undefined>;
  logFile?: string;
}): LoggedChild {
  return spawnLogged(process.execPath, [input.serverJs], {
    cwd: dirname(input.serverJs),
    ...(input.logFile !== undefined ? { logFile: input.logFile } : {}),
    env: { ...input.env, PORT: String(SCOPE_DASHBOARD_PORT), HOSTNAME: "127.0.0.1" }
  });
}

/**
 * Monorepo dev fallback: build the scope app once (reusing a prior build) and
 * `next start` it on the fixed port. Only reached in a handoffkit checkout where
 * no bundle was staged; published installs always use {@link startBundledDashboard}.
 */
function startDevDashboard(input: {
  env: Record<string, string | undefined>;
  identity: string;
  logFile?: string;
}): LoggedChild {
  const scopeDir = findScopeAppDir();
  const nextBin = join(scopeDir, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    throw new Error(
      "the observability dashboard is not available in this checkout.\n" +
        `  Install its dependencies once: cd ${scopeDir} && pnpm install`
    );
  }

  // Rebuild only when the source identity changes. This keeps normal runs fast
  // while making fusionkit-dev pick up companion edits automatically.
  const buildIdentityFile = join(scopeDir, ".next", SCOPE_BUILD_IDENTITY_FILE);
  const alreadyBuilt =
    existsSync(join(scopeDir, ".next", "BUILD_ID")) && readTrimmed(buildIdentityFile) === input.identity;
  if (!alreadyBuilt) {
    try {
      const buildOut = execFileSync(nextBin, ["build"], {
        cwd: scopeDir,
        env: input.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (input.logFile !== undefined) appendFileSync(input.logFile, buildOut);
      writeFileSync(buildIdentityFile, `${input.identity}\n`);
    } catch (error) {
      if (input.logFile !== undefined) {
        appendFileSync(
          input.logFile,
          String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "")
        );
      }
      throw new Error(
        "the observability dashboard failed to build. See the log for details" +
          (input.logFile ? `: ${input.logFile}` : "")
      );
    }
  }

  return spawnLogged(nextBin, ["start", "-p", String(SCOPE_DASHBOARD_PORT)], {
    cwd: scopeDir,
    ...(input.logFile !== undefined ? { logFile: input.logFile } : {}),
    env: input.env
  });
}

async function probeDashboardIdentity(loopbackUrl: string, expectedIdentity: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${loopbackUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const health = (await response.json()) as { identity?: unknown };
    if (typeof health.identity !== "string") return undefined;
    if (health.identity === SCOPE_DEV_SERVER_IDENTITY && process.env.FUSIONKIT_DEV === "1") {
      return expectedIdentity;
    }
    return health.identity;
  } catch {
    return undefined;
  }
}

/**
 * Start the scope dashboard on the fixed port, backed by a fresh per-run SQLite
 * file, and return the OTLP endpoint the caller exports (as
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) into every spawned process. Prefers the
 * prebuilt bundle shipped inside the npm package; falls back to building the
 * app from source in a monorepo dev checkout.
 */
export async function startObservability(input: {
  log: (line: string) => void;
  logFile?: string;
  report?: StackReporter;
  portless: PortlessSession;
}): Promise<Observability> {
  const stateDir = mkdtempSync(join(tmpdir(), "fusion-scope-"));
  const dbPath = join(stateDir, "scope.db");
  const bundled = bundledScopeServer();
  const dashboardIdentity = bundled !== undefined ? SCOPE_BUNDLED_IDENTITY : scopeSourceIdentity();

  // The dashboard server loads node:sqlite; keep its experimental warnings out
  // of the log just like the parent CLI. The per-run db/trace dir isolate state.
  const childEnv = withCaEnv(
    {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" "),
      SCOPEKIT_DB: dbPath,
      SCOPEKIT_DASHBOARD_ID: dashboardIdentity
    },
    input.portless.caCertPath
  );

  const spawnDashboard = async (): Promise<{ port: number; pid?: number; close: () => void }> => {
    if (input.report) input.report({ kind: "dashboard.start" });
    else if (bundled !== undefined) input.log("fusion: starting observability dashboard...");
    else input.log("fusion: building observability dashboard if source changed...");

    let proc: LoggedChild;
    try {
      proc =
        bundled !== undefined
          ? startBundledDashboard({
              serverJs: bundled,
              env: childEnv,
              ...(input.logFile !== undefined ? { logFile: input.logFile } : {})
            })
          : startDevDashboard({
              env: childEnv,
              identity: dashboardIdentity,
              ...(input.logFile !== undefined ? { logFile: input.logFile } : {})
            });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    try {
      await waitForHttp(`http://127.0.0.1:${SCOPE_DASHBOARD_PORT}`, proc, {
        timeoutMs: 60_000,
        label: "dashboard"
      });
    } catch (error) {
      terminate(proc.child);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return {
      port: SCOPE_DASHBOARD_PORT,
      ...(proc.child.pid !== undefined ? { pid: proc.child.pid } : {}),
      close: () => terminate(proc.child)
    };
  };

  let resolved: Awaited<ReturnType<PortlessSession["discoverOrSpawn"]>>;
  try {
    resolved = await input.portless.discoverOrSpawn({
      name: "scope",
      identity: dashboardIdentity,
      healthCheck: (loopbackUrl) => probeDashboardIdentity(loopbackUrl, dashboardIdentity),
      replaceStale: true,
      spawn: spawnDashboard
    });
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true });
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (input.report) input.report({ kind: "dashboard.ready", detail: resolved.url });
  else input.log(`fusion: observability dashboard ready on ${resolved.url}`);

  return {
    url: resolved.url,
    // Spans post over loopback (the OTLP exporters do not carry the portless
    // CA), so ingest uses the raw port; the named URL is for humans.
    otlpUrl: `${resolved.loopbackUrl}/api/ingest`,
    close: async () => {
      await resolved.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}
