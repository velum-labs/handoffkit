/**
 * The local scope observability dashboard: locating the prebuilt bundle (or
 * building it from source in a monorepo checkout), starting it on the fixed
 * port, and exposing the trace URLs the orchestrator injects into spawned
 * children.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const serverJs = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scope", "server.js");
  return existsSync(serverJs) ? serverJs : undefined;
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
  ingestUrl: string;
  traceDir: string;
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
  traceDir: string;
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

  // Rebuilding every run is slow; reuse a prior build when present. The build
  // output is captured (never inherited) so it can't corrupt a live checklist.
  const alreadyBuilt = existsSync(join(scopeDir, ".next", "BUILD_ID"));
  if (!alreadyBuilt) {
    try {
      const buildOut = execFileSync(nextBin, ["build"], {
        cwd: scopeDir,
        env: input.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (input.logFile !== undefined) appendFileSync(input.logFile, buildOut);
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

/** Identity token of a reusable scope dashboard (any healthy instance qualifies). */
const SCOPE_IDENTITY = "scope-dashboard";

/**
 * Start the scope dashboard on the fixed port, backed by a fresh per-run SQLite
 * file and trace dir, and return the URLs the caller injects (as
 * FUSION_TRACE_URL / FUSION_TRACE_DIR) into every spawned process. Prefers the
 * prebuilt bundle shipped inside the npm package; falls back to building the
 * app from source in a monorepo dev checkout.
 */
export async function startObservability(input: {
  log: (line: string) => void;
  logFile?: string;
  report?: StackReporter;
  portless: PortlessSession;
}): Promise<Observability> {
  const traceDir = mkdtempSync(join(tmpdir(), "fusion-trace-"));
  const dbPath = join(traceDir, "scope.db");

  // The dashboard server loads node:sqlite; keep its experimental warnings out
  // of the log just like the parent CLI. The per-run db/trace dir isolate state.
  const childEnv = withCaEnv(
    {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" "),
      SCOPEKIT_DB: dbPath,
      FUSION_TRACE_DIR: traceDir
    },
    input.portless.caCertPath
  );

  const spawnDashboard = async (): Promise<{ port: number; pid?: number; close: () => void }> => {
    const bundled = bundledScopeServer();
    if (input.report) input.report({ kind: "dashboard.start" });
    else if (bundled !== undefined) input.log("fusion: starting observability dashboard...");
    else input.log("fusion: building observability dashboard (one-time)...");

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
              traceDir,
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
      identity: SCOPE_IDENTITY,
      healthCheck: async (loopbackUrl) => {
        try {
          const response = await fetch(loopbackUrl, { signal: AbortSignal.timeout(2000) });
          return response.ok ? SCOPE_IDENTITY : undefined;
        } catch {
          return undefined;
        }
      },
      spawn: spawnDashboard
    });
  } catch (error) {
    rmSync(traceDir, { recursive: true, force: true });
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (input.report) input.report({ kind: "dashboard.ready", detail: resolved.url });
  else input.log(`fusion: observability dashboard ready on ${resolved.url}`);

  return {
    url: resolved.url,
    // Trace events post over loopback (the in-process emitters do not carry the
    // portless CA), so ingest uses the raw port; the named URL is for humans.
    ingestUrl: `${resolved.loopbackUrl}/api/ingest`,
    traceDir,
    close: async () => {
      await resolved.close();
      rmSync(traceDir, { recursive: true, force: true });
    }
  };
}
