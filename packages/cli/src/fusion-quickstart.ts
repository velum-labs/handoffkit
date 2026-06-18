/**
 * `warrant fusion <tool>` — one command, everything real.
 *
 * Spawns a real local MLX trio (the panel), starts the Fusion Harness Gateway
 * over a real model-backed coding harness (each panel model produces a real
 * candidate patch in its own git worktree on a real repo) with real judge
 * synthesis, then launches the chosen coding agent (Codex / Claude Code /
 * Cursor) pre-wired to the gateway. One Ctrl+C tears the whole stack down.
 *
 * No mocks: the panel is real local models, candidates are real patches
 * verified by really running the repo's tests, and the judge is a real model.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { EnsembleModel } from "@warrant/ensemble";
import { MlxBackend, startGateway } from "@warrant/model-gateway";
import type { Gateway } from "@warrant/model-gateway";

import { gatewaySetupSnippets, startConfiguredGateway, startFusionStepGateway } from "./gateway.js";
import { claudeEnv, codexConfigToml } from "./local.js";

export type FusionTool = "codex" | "claude" | "cursor" | "serve";

export const FUSION_TOOLS: readonly FusionTool[] = ["codex", "claude", "cursor", "serve"];

/** The model label the launched tool uses; the gateway ignores it for routing. */
const FUSION_MODEL_LABEL = "fusion-panel";

export type PanelProvider = "mlx" | "openai" | "anthropic" | "google" | "openai-compatible";

/**
 * One panel model. `mlx` models run locally via the in-repo provisioner; cloud
 * providers (openai/anthropic/google/openai-compatible) are fronted as
 * OpenAI-compatible endpoints by FusionKit's `simple_openai_server.py`, which
 * requires `--fusionkit-dir` / `WARRANT_FUSIONKIT_DIR`.
 */
export type PanelModelSpec = {
  id: string;
  model: string;
  provider?: PanelProvider;
  baseUrl?: string;
  keyEnv?: string;
};

/** The verified, locally cached trio used as the default real panel. */
export const DEFAULT_TRIO: readonly PanelModelSpec[] = [
  { id: "qwen", model: "mlx-community/Qwen3-1.7B-4bit", provider: "mlx" },
  { id: "gemma", model: "mlx-community/gemma-3-1b-it-4bit", provider: "mlx" },
  { id: "llama", model: "mlx-community/Llama-3.2-1B-Instruct-4bit", provider: "mlx" }
];

/**
 * Parse a `.env` file (KEY=VALUE lines, `#` comments, optional `export`,
 * single/double quotes) and fill any keys not already present in `env`.
 * Existing env values win, so an explicitly exported key is never overridden.
 */
export function loadEnvFileInto(path: string, env: Record<string, string | undefined>): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/** Default env var holding the API key for each cloud provider. */
export function defaultKeyEnv(provider: PanelProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GEMINI_API_KEY";
    case "openai-compatible":
    case "mlx":
      return undefined;
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

/** Absolute path to the compiled solve agent shipped alongside this module. */
export function solveAgentPath(): string {
  return fileURLToPath(new URL("./fusion-solve-agent.js", import.meta.url));
}

/** The git repository root containing `dir`, or undefined if it is not in a repo. */
export function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      // Don't leak git's "fatal: not a git repository" to our stderr; we surface
      // a clearer message ourselves.
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

/** Fixed port for the local observability dashboard (the scope app). */
export const SCOPE_DASHBOARD_PORT = 4317;

/**
 * Locate the isolated scope dashboard app (handoffkit/apps/scope) by walking up
 * from this module. Works from both the compiled dist and src layouts.
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

/** Poll an HTTP endpoint until it answers (any status) or the child dies. */
async function waitForHttpReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dashboard exited (code ${child.exitCode}) before becoming ready`);
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`dashboard did not become ready within ${timeoutMs}ms (${lastError})`);
}

/** Best-effort: open a URL in the default browser (no-op on failure). */
function openUrl(url: string): void {
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
 * Build the scope dashboard once and `next start` it on the fixed port, backed
 * by a fresh per-run SQLite file and trace dir. Returns the URLs the caller
 * injects (as FUSION_TRACE_URL / FUSION_TRACE_DIR) into every spawned process.
 */
export async function startObservability(input: { log: (line: string) => void }): Promise<Observability> {
  const scopeDir = findScopeAppDir();
  const nextBin = join(scopeDir, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    throw new Error(
      `scope dashboard dependencies are not installed.\n  Run: cd ${scopeDir} && pnpm install`
    );
  }

  const traceDir = mkdtempSync(join(tmpdir(), "fusion-trace-"));
  const dbPath = join(traceDir, "scope.db");

  input.log("fusion: building observability dashboard (one-time)...");
  execFileSync(nextBin, ["build"], { cwd: scopeDir, stdio: "inherit", env: { ...process.env } });

  input.log("fusion: starting observability dashboard...");
  const child = spawn(nextBin, ["start", "-p", String(SCOPE_DASHBOARD_PORT)], {
    cwd: scopeDir,
    env: { ...process.env, SCOPEKIT_DB: dbPath, FUSION_TRACE_DIR: traceDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));

  const url = `http://127.0.0.1:${SCOPE_DASHBOARD_PORT}`;
  try {
    await waitForHttpReady(url, child, 60_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.slice(-500)}`);
  }

  return {
    url,
    ingestUrl: `${url}/api/ingest`,
    traceDir,
    close: async () => {
      child.kill("SIGTERM");
    }
  };
}

function freePort(): Promise<number> {
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

/**
 * Create a real git repo with a genuinely failing test, so each panel model has
 * a concrete coding task. Used when the caller does not pass their own --repo.
 */
export function materializeSampleRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root });
  };
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "fusion@warrant.local"]);
  git(["config", "user.name", "warrant-fusion"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fusion-sample", private: true, scripts: { test: "node --test" } }, null, 2) + "\n"
  );
  writeFileSync(join(root, "calculator.js"), "exports.add = (left, right) => left - right;\n");
  writeFileSync(
    join(root, "calculator.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calculator.js');",
      "assert.equal(add(2, 3), 5);",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(root, "README.md"),
    "# fusion sample\n\n`add` is buggy (it subtracts); `npm test` fails until it is fixed.\n"
  );
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "failing calculator sample"]);
  return root;
}

export type ModelServers = {
  endpoints: Record<string, string>;
  judgeUrl: string;
  judgeModel: string;
  models: EnsembleModel[];
  close: () => Promise<void>;
};

async function waitForEndpoint(url: string, label: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited (code ${child.exitCode}) before becoming ready`);
    try {
      const response = await fetch(`${url}/v1/models`);
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${lastError})`);
}

/**
 * Spawn FusionKit's single-endpoint OpenAI-compatible server for one cloud
 * model, so the per-candidate coding harness can call it like any other
 * OpenAI-compatible backend. Anthropic/OpenAI/Google calls go through
 * FusionKit's provider clients.
 */
async function spawnCloudServer(input: {
  spec: PanelModelSpec;
  provider: Exclude<PanelProvider, "mlx">;
  fusionkitDir: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const keyEnv = input.spec.keyEnv ?? defaultKeyEnv(input.provider);
  const args = [
    "run",
    "python",
    "scripts/simple_openai_server.py",
    "--id",
    input.spec.id,
    "--model",
    input.spec.model,
    "--provider",
    input.provider,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    ...(input.spec.baseUrl !== undefined ? ["--base-url", input.spec.baseUrl] : []),
    ...(keyEnv !== undefined ? ["--api-key-env", keyEnv] : [])
  ];
  input.log(`fusion: starting ${input.spec.id} (${input.provider}:${input.spec.model})...`);
  const child = spawn("uv", args, { cwd: input.fusionkitDir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForEndpoint(url, `${input.spec.id} server`, child, 30_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log.slice(-500)}`);
  }
  input.log(`fusion: ${input.spec.id} ready on ${url}`);
  return { url, child };
}

/**
 * Bring up one real model server per panel model and return an id -> base URL
 * map. `mlx` specs run locally; cloud specs are fronted by FusionKit. When
 * `endpoints` is supplied (pre-running servers or tests), those are used
 * verbatim and nothing is spawned.
 */
export async function startModelServers(options: {
  specs: PanelModelSpec[];
  endpoints?: Record<string, string>;
  fusionkitDir?: string;
  log: (line: string) => void;
}): Promise<ModelServers> {
  const { specs } = options;
  const judge = specs[0];
  if (judge === undefined) throw new Error("at least one panel model is required");
  const models: EnsembleModel[] = specs.map((spec) => ({ id: spec.id, model: spec.model }));

  if (options.endpoints !== undefined) {
    return {
      endpoints: options.endpoints,
      judgeUrl: options.endpoints[judge.id] ?? Object.values(options.endpoints)[0] ?? "",
      judgeModel: judge.model,
      models,
      close: async () => {}
    };
  }

  // Cloud servers inherit the parent env plus the FusionKit checkout's `.env`
  // (so OPENAI_API_KEY / ANTHROPIC_API_KEY load seamlessly), without overriding
  // anything already exported.
  const cloudEnv: Record<string, string | undefined> = { ...process.env };
  if (options.fusionkitDir !== undefined) {
    loadEnvFileInto(join(options.fusionkitDir, ".env"), cloudEnv);
  }

  const gateways: Gateway[] = [];
  const backends: MlxBackend[] = [];
  const children: ChildProcess[] = [];
  const endpoints: Record<string, string> = {};
  const closeAll = async (): Promise<void> => {
    for (const child of children) child.kill("SIGTERM");
    await Promise.allSettled(gateways.map((gateway) => gateway.close()));
    await Promise.allSettled(backends.map((backend) => backend.stop()));
  };
  try {
    for (const spec of specs) {
      const provider = spec.provider ?? "mlx";
      if (provider === "mlx") {
        options.log(`fusion: loading ${spec.id} (${spec.model})...`);
        const backend = new MlxBackend({ model: spec.model });
        await backend.start();
        const gateway = await startGateway({ backend });
        backends.push(backend);
        gateways.push(gateway);
        endpoints[spec.id] = gateway.url();
        options.log(`fusion: ${spec.id} ready on ${gateway.url()}`);
      } else {
        if (options.fusionkitDir === undefined) {
          throw new Error(
            `cloud panel model "${spec.id}" (${provider}) requires --fusionkit-dir or WARRANT_FUSIONKIT_DIR`
          );
        }
        const started = await spawnCloudServer({
          spec,
          provider,
          fusionkitDir: options.fusionkitDir,
          env: cloudEnv,
          log: options.log
        });
        children.push(started.child);
        endpoints[spec.id] = started.url;
      }
    }
  } catch (error) {
    await closeAll();
    throw error;
  }

  return {
    endpoints,
    judgeUrl: endpoints[judge.id] as string,
    judgeModel: judge.model,
    models,
    close: closeAll
  };
}

export type FusionStack = {
  fusionUrl: string;
  endpoints: Record<string, string>;
  close: () => Promise<void>;
};

/** The per-candidate harness: `agent` (trajectory fusion, default) or `command`. */
export type FusionHarness = "agent" | "command";

export type StartFusionStackOptions = {
  repo: string;
  outputRoot: string;
  models: PanelModelSpec[];
  endpoints?: Record<string, string>;
  fusionkitDir?: string;
  harness?: FusionHarness;
  judgeModel?: string;
  judgeUrl?: string;
  /** Pre-running fusionkit serve URL for trajectory synthesis (skips spawn). */
  synthesisUrl?: string;
  command?: string;
  host?: string;
  port?: number;
  authToken?: string;
  timeoutMs?: number;
  log: (line: string) => void;
};

/**
 * Spawn a `fusionkit serve` as the trajectory-synthesis backend, configured
 * with the judge model. FusionKit owns synthesis, so the agent harness fuses
 * its trajectories through this server's `/v1/fusion/trajectories:fuse`.
 */
export async function startSynthesisServer(input: {
  fusionkitDir: string;
  judgeModel: string;
  judgeBaseUrl: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const config = [
    "endpoints:",
    "  - id: judge",
    "    provider: openai-compatible",
    `    model: ${JSON.stringify(input.judgeModel)}`,
    `    base_url: ${JSON.stringify(input.judgeBaseUrl)}`,
    "    api_key: not-needed",
    "default_model: judge",
    "judge_model: judge",
    "synthesizer_model: judge",
    // Generous budget: reasoning models (gpt-5.x) spend tokens on reasoning
    // before producing content, so a small cap can yield an empty answer.
    "sampling: {temperature: 0.2, top_p: 0.9, max_tokens: 8192}",
    ""
  ].join("\n");
  const configPath = join(mkdtempSync(join(tmpdir(), "fusion-synth-")), "synthesis.yaml");
  writeFileSync(configPath, config);
  input.log("fusion: starting synthesis backend (fusionkit serve)...");
  const child = spawn(
    "uv",
    ["run", "fusionkit", "serve", "--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
    { cwd: input.fusionkitDir, env: input.env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForEndpoint(url, "synthesis backend", child, 60_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log.slice(-500)}`);
  }
  input.log(`fusion: synthesis backend ready on ${url}`);
  return { child, url };
}

export async function startFusionStack(options: StartFusionStackOptions): Promise<FusionStack> {
  const harness: FusionHarness = options.harness ?? "agent";
  const servers = await startModelServers({
    specs: options.models,
    ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
    ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
    log: options.log
  });

  let synthesisChild: ChildProcess | undefined;
  let synthesisUrl = options.synthesisUrl ?? options.judgeUrl ?? servers.judgeUrl;
  try {
    if (harness === "agent" && options.synthesisUrl === undefined) {
      if (options.fusionkitDir === undefined) {
        throw new Error("trajectory synthesis requires --fusionkit-dir or WARRANT_FUSIONKIT_DIR");
      }
      const cloudEnv: Record<string, string | undefined> = { ...process.env };
      loadEnvFileInto(join(options.fusionkitDir, ".env"), cloudEnv);
      const synthesis = await startSynthesisServer({
        fusionkitDir: options.fusionkitDir,
        judgeModel: options.judgeModel ?? servers.judgeModel,
        judgeBaseUrl: servers.judgeUrl,
        env: cloudEnv,
        log: options.log
      });
      synthesisChild = synthesis.child;
      synthesisUrl = synthesis.url;
    }

    // The agent harness uses the judge-streamed-trajectory front door (the judge
    // emits a trajectory the user's tool executes); the command harness keeps the
    // one-shot synthesis front door.
    const gatewayConfig = {
      fusionBackendUrl: synthesisUrl,
      repo: options.repo,
      outputRoot: options.outputRoot,
      harnesses: [harness],
      models: servers.models,
      ...(harness === "command" ? { command: options.command ?? `node ${solveAgentPath()}` } : {}),
      judgeModel: options.judgeModel ?? servers.judgeModel,
      modelEndpoints: servers.endpoints,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    };
    const startGatewayForHarness =
      harness === "agent" ? startFusionStepGateway : startConfiguredGateway;
    const gateway = await startGatewayForHarness({
      config: gatewayConfig,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {})
    });
    return {
      fusionUrl: gateway.url(),
      endpoints: servers.endpoints,
      close: async () => {
        await gateway.close();
        if (synthesisChild !== undefined) synthesisChild.kill("SIGTERM");
        await servers.close();
      }
    };
  } catch (error) {
    if (synthesisChild !== undefined) synthesisChild.kill("SIGTERM");
    await servers.close();
    throw error;
  }
}

function spawnTool(
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

function scrubbedBridgeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("BRIDGE_") || key.startsWith("MODEL_") || key.startsWith("E2E_") || key.startsWith("CURSOR_UPSTREAM")) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Start the Cursorkit bridge with its local-model backend pointed at the fusion
 * gateway, and resolve once it is listening. Returns the child and its port.
 */
export async function startCursorBridge(input: {
  cursorKitDir: string;
  fusionUrl: string;
  log: (line: string) => void;
}): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const env = {
    ...scrubbedBridgeEnv(),
    BRIDGE_PORT: String(port),
    BRIDGE_ROUTE_INVENTORY: "true",
    CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
    MODEL_BASE_URL: `${input.fusionUrl}/v1`,
    MODEL_API_KEY: "local",
    MODEL_NAME: FUSION_MODEL_LABEL,
    MODEL_PROVIDER_MODEL: FUSION_MODEL_LABEL,
    MODEL_CONTEXT_TOKEN_LIMIT: "128000"
  };
  const child = spawn(process.execPath, ["dist/src/cli.js", "serve"], {
    cwd: input.cursorKitDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (/bridge listening/.test(output)) resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => reject(new Error(`Cursorkit bridge exited before listening:\n${output.slice(-500)}`)));
    setTimeout(() => reject(new Error(`Cursorkit bridge did not start within 20s:\n${output.slice(-500)}`)), 20_000);
  });
  await ready;
  input.log(`fusion: Cursorkit bridge listening on http://127.0.0.1:${port}`);
  return { child, port };
}

export type RunFusionOptions = {
  models?: PanelModelSpec[];
  endpoints?: Record<string, string>;
  fusionkitDir?: string;
  harness?: FusionHarness;
  repo?: string;
  command?: string;
  judgeModel?: string;
  judgeEndpoint?: string;
  synthesisUrl?: string;
  cursorKitDir?: string;
  authToken?: string;
  port?: number;
  timeoutMs?: number;
  /** Boot the local scope dashboard and stream trace events into it. */
  observe?: boolean;
  log?: (line: string) => void;
};

export async function runFusion(
  tool: FusionTool,
  toolArgs: string[],
  options: RunFusionOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const root = mkdtempSync(join(tmpdir(), "warrant-fusion-"));
  // Default the fused repo to the current directory's git repo: the panel models
  // and the launched harness must operate on the SAME codebase, and the launched
  // tool runs in this repo (below). No hidden sample repo — if the user wants a
  // different repo they pass --repo.
  let repo = options.repo;
  if (repo === undefined) {
    const toplevel = gitToplevel(process.cwd());
    if (toplevel === undefined) {
      throw new Error(
        "no --repo given and the current directory is not a git repository; " +
          "cd into your project (or pass --repo <dir>) so the panel fuses over the code you're working on"
      );
    }
    repo = toplevel;
  }
  const models = options.models ?? [...DEFAULT_TRIO];

  log(`fusion: panel = ${models.map((model) => model.id).join(", ")}`);
  log(`fusion: repo = ${repo}`);

  // When --observe is set, boot the dashboard and export the trace env BEFORE
  // anything starts, so the in-process gateway/ensemble/agent emitters and every
  // spawned child (panel servers, synthesis serve, cursor bridge) inherit it.
  // Without the flag, FUSION_TRACE_* stays unset and all emitters are no-ops.
  let observability: Observability | undefined;
  if (options.observe === true) {
    observability = await startObservability({ log });
    process.env.FUSION_TRACE_URL = observability.ingestUrl;
    process.env.FUSION_TRACE_DIR = observability.traceDir;
    log(`fusion: observability dashboard at ${observability.url}`);
    log(`fusion: trace events -> ${observability.ingestUrl} (jsonl fallback in ${observability.traceDir})`);
    openUrl(observability.url);
  }

  let stack: FusionStack;
  try {
    stack = await startFusionStack({
      repo,
      outputRoot: join(root, "runs"),
      models,
      ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
      ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {}),
      ...(options.harness !== undefined ? { harness: options.harness } : {}),
      ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
      ...(options.judgeEndpoint !== undefined ? { judgeUrl: options.judgeEndpoint } : {}),
      ...(options.synthesisUrl !== undefined ? { synthesisUrl: options.synthesisUrl } : {}),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      log
    });
  } catch (error) {
    if (observability !== undefined) await observability.close().catch(() => {});
    throw error;
  }
  log(`fusion: gateway on ${stack.fusionUrl} (model: ${FUSION_MODEL_LABEL})`);

  let bridge: ChildProcess | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (bridge !== undefined) {
      try {
        bridge.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await stack.close().catch(() => {});
    if (observability !== undefined) await observability.close().catch(() => {});
  };
  const onSignal = (): void => {
    void cleanup().then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    switch (tool) {
      case "serve": {
        log("");
        log(gatewaySetupSnippets(stack.fusionUrl, "http://127.0.0.1:<cursorkit-port>"));
        log("");
        log("Gateway is running. Point any tool at it, or Ctrl+C to stop.");
        await new Promise<void>(() => {
          /* run until interrupted */
        });
        return 0;
      }
      case "codex": {
        const home = mkdtempSync(join(tmpdir(), "warrant-fusion-codex-"));
        writeFileSync(join(home, "config.toml"), codexConfigToml(stack.fusionUrl, FUSION_MODEL_LABEL));
        log("fusion: launching codex (each prompt is a coding task fused across the panel)...");
        return await spawnTool("codex", toolArgs, { CODEX_HOME: home }, repo);
      }
      case "claude": {
        log("fusion: launching claude...");
        return await spawnTool("claude", toolArgs, claudeEnv(stack.fusionUrl, options.authToken), repo);
      }
      case "cursor": {
        const cursorKitDir = options.cursorKitDir ?? process.env.WARRANT_CURSORKIT_DIR;
        if (cursorKitDir === undefined || cursorKitDir.length === 0) {
          log("");
          log("Cursor needs a built Cursorkit checkout. Re-run with --cursor-kit-dir <dir>");
          log("(or set WARRANT_CURSORKIT_DIR), then this command spawns the bridge and");
          log("launches cursor-agent pre-wired to the gateway. Manual setup:");
          log(`  MODEL_BASE_URL=${stack.fusionUrl}/v1 MODEL_NAME=${FUSION_MODEL_LABEL} \\`);
          log("  MODEL_PROVIDER_MODEL=fusion-panel node dist/src/cli.js serve   # in cursorkit");
          log(`  cursor-agent --endpoint http://127.0.0.1:<bridge-port> --model ${FUSION_MODEL_LABEL}`);
          return 1;
        }
        const started = await startCursorBridge({ cursorKitDir, fusionUrl: stack.fusionUrl, log });
        bridge = started.child;
        log("fusion: launching cursor-agent...");
        return await spawnTool(
          "cursor-agent",
          ["--endpoint", `http://127.0.0.1:${started.port}`, "--model", FUSION_MODEL_LABEL, ...toolArgs],
          {},
          repo
        );
      }
      default: {
        const unreachable: never = tool;
        throw new Error(`unknown fusion tool: ${String(unreachable)}`);
      }
    }
  } finally {
    await cleanup();
  }
}

/** Interactive tool picker for when no `--tool` was provided on a TTY. */
export async function pickTool(): Promise<FusionTool> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      [
        "Which coding agent should model fusion back?",
        "  1) codex   — OpenAI Codex CLI",
        "  2) claude  — Claude Code",
        "  3) cursor  — cursor-agent (needs --cursor-kit-dir / WARRANT_CURSORKIT_DIR)",
        "  4) serve   — just run the gateway and print setup",
        ""
      ].join("\n")
    );
    const answer = (await new Promise<string>((resolve) => rl.question("Choose [1-4]: ", resolve))).trim().toLowerCase();
    switch (answer) {
      case "1":
      case "codex":
        return "codex";
      case "2":
      case "claude":
        return "claude";
      case "3":
      case "cursor":
        return "cursor";
      case "4":
      case "serve":
        return "serve";
      default:
        return "codex";
    }
  } finally {
    rl.close();
  }
}
