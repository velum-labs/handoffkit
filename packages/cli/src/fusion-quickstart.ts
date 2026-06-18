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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { EnsembleModel } from "@warrant/ensemble";
import { MlxBackend, startGateway } from "@warrant/model-gateway";
import type { Gateway } from "@warrant/model-gateway";

import { gatewaySetupSnippets, startConfiguredGateway } from "./gateway.js";
import { claudeEnv, codexConfigToml } from "./local.js";

export type FusionTool = "codex" | "claude" | "cursor" | "serve";

export const FUSION_TOOLS: readonly FusionTool[] = ["codex", "claude", "cursor", "serve"];

/** The model label the launched tool uses; the gateway ignores it for routing. */
const FUSION_MODEL_LABEL = "fusion-panel";

/** The verified, locally cached trio used as the default real panel. */
export const DEFAULT_TRIO: readonly EnsembleModel[] = [
  { id: "qwen", model: "mlx-community/Qwen3-1.7B-4bit" },
  { id: "gemma", model: "mlx-community/gemma-3-1b-it-4bit" },
  { id: "llama", model: "mlx-community/Llama-3.2-1B-Instruct-4bit" }
];

/** Absolute path to the compiled solve agent shipped alongside this module. */
export function solveAgentPath(): string {
  return fileURLToPath(new URL("./fusion-solve-agent.js", import.meta.url));
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

/**
 * Bring up one real local model server per panel model and return an
 * id -> base URL map. When `endpoints` is supplied (e.g. pre-running servers or
 * tests), those are used verbatim and nothing is spawned.
 */
export async function startModelServers(options: {
  models: EnsembleModel[];
  endpoints?: Record<string, string>;
  log: (line: string) => void;
}): Promise<ModelServers> {
  const { models } = options;
  if (options.endpoints !== undefined) {
    const judge = models[0];
    if (judge === undefined) throw new Error("at least one panel model is required");
    return {
      endpoints: options.endpoints,
      judgeUrl: options.endpoints[judge.id] ?? Object.values(options.endpoints)[0] ?? "",
      judgeModel: judge.model,
      models,
      close: async () => {}
    };
  }

  const started: Array<{ gateway: Gateway; backend: MlxBackend }> = [];
  const endpoints: Record<string, string> = {};
  try {
    for (const model of models) {
      options.log(`fusion: loading ${model.id} (${model.model})...`);
      const backend = new MlxBackend({ model: model.model });
      await backend.start();
      const gateway = await startGateway({ backend });
      started.push({ gateway, backend });
      endpoints[model.id] = gateway.url();
      options.log(`fusion: ${model.id} ready on ${gateway.url()}`);
    }
  } catch (error) {
    await Promise.allSettled(started.map(({ gateway }) => gateway.close()));
    await Promise.allSettled(started.map(({ backend }) => backend.stop()));
    throw error;
  }

  const judge = models[0] as EnsembleModel;
  return {
    endpoints,
    judgeUrl: endpoints[judge.id] as string,
    judgeModel: judge.model,
    models,
    close: async () => {
      await Promise.allSettled(started.map(({ gateway }) => gateway.close()));
      await Promise.allSettled(started.map(({ backend }) => backend.stop()));
    }
  };
}

export type FusionStack = {
  fusionUrl: string;
  endpoints: Record<string, string>;
  close: () => Promise<void>;
};

export type StartFusionStackOptions = {
  repo: string;
  outputRoot: string;
  models: EnsembleModel[];
  endpoints?: Record<string, string>;
  judgeModel?: string;
  command?: string;
  host?: string;
  port?: number;
  authToken?: string;
  timeoutMs?: number;
  log: (line: string) => void;
};

export async function startFusionStack(options: StartFusionStackOptions): Promise<FusionStack> {
  const servers = await startModelServers({
    models: options.models,
    ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
    log: options.log
  });
  try {
    const gateway = await startConfiguredGateway({
      config: {
        fusionBackendUrl: servers.judgeUrl,
        repo: options.repo,
        outputRoot: options.outputRoot,
        harnesses: ["command"],
        models: servers.models,
        command: options.command ?? `node ${solveAgentPath()}`,
        judgeModel: options.judgeModel ?? servers.judgeModel,
        modelEndpoints: servers.endpoints,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      },
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {})
    });
    return {
      fusionUrl: gateway.url(),
      endpoints: servers.endpoints,
      close: async () => {
        await gateway.close();
        await servers.close();
      }
    };
  } catch (error) {
    await servers.close();
    throw error;
  }
}

function spawnTool(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
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
  models?: EnsembleModel[];
  endpoints?: Record<string, string>;
  repo?: string;
  command?: string;
  judgeModel?: string;
  cursorKitDir?: string;
  authToken?: string;
  port?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export async function runFusion(
  tool: FusionTool,
  toolArgs: string[],
  options: RunFusionOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const root = mkdtempSync(join(tmpdir(), "warrant-fusion-"));
  const repo = options.repo ?? materializeSampleRepo(join(root, "repo"));
  const models = options.models ?? [...DEFAULT_TRIO];

  log(`fusion: panel = ${models.map((model) => model.id).join(", ")}`);
  if (options.repo === undefined) log(`fusion: sample repo at ${repo} (a failing test to fix)`);

  const stack = await startFusionStack({
    repo,
    outputRoot: join(root, "runs"),
    models,
    ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
    ...(options.judgeModel !== undefined ? { judgeModel: options.judgeModel } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    log
  });
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
        return await spawnTool("codex", toolArgs, { CODEX_HOME: home });
      }
      case "claude": {
        log("fusion: launching claude...");
        return await spawnTool("claude", toolArgs, claudeEnv(stack.fusionUrl, options.authToken));
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
          {}
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
