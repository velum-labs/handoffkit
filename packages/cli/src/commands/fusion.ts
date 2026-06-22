import { resolve } from "node:path";

import type { Command } from "commander";

import { FUSION_TOOLS, gitToplevel, pickTool, runFusion } from "../fusion-quickstart.js";
import type { FusionTool, RunFusionOptions } from "../fusion-quickstart.js";
import { loadFusionConfig } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { runFusionInit } from "../fusion-init.js";
import { runClaudeRoute } from "../fusion/claude-route.js";
import { fail } from "../shared/errors.js";
import { collect, parseFusionTool, parseIdValue, parsePanelModelSpec, parsePort } from "../shared/options.js";
import { reapFusionServices } from "../shared/portless.js";

type FusionOpts = {
  tool?: string;
  model?: string[];
  models?: string[];
  modelEndpoint?: string[];
  keyEnv?: string[];
  judgeModel?: string;
  synthesisUrl?: string;
  fusionkitDir?: string;
  repo?: string;
  local?: boolean;
  observe?: boolean;
  yes?: boolean;
  force?: boolean;
  authToken?: string;
  port?: string;
  portless?: boolean;
  route?: boolean;
  routeDryRun?: boolean;
  routePreview?: string;
};

/** Attach the panel/gateway flags shared by `fusion` and the per-tool launchers. */
function applyFusionOptions(command: Command): Command {
  return command
    .option("--model <spec>", "panel model ID=MODEL or ID=PROVIDER:MODEL (repeatable)", collect)
    .option("--models <spec>", "alias of --model", collect)
    .option("--model-endpoint <spec>", "pre-running OpenAI-compatible endpoint ID=URL (repeatable)", collect)
    .option("--key-env <spec>", "env var holding a model's API key ID=ENV (repeatable)", collect)
    .option("--judge-model <model>", "model used for judge synthesis")
    .option("--synthesis-url <url>", "pre-running fusionkit serve for synthesis")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for the uvx synthesizer)")
    .option("--repo <dir>", "coding workspace the panel fuses over")
    .option("--local", "use the local MLX panel trio instead of the default cloud panel")
    .option("--no-local", "override a .fusionkit default of local=true")
    .option("--observe", "boot the local scope dashboard and stream live trace events")
    .option("--no-observe", "override a .fusionkit default of observe=true")
    .option("--yes", "skip the interactive cloud-panel cost confirmation")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .option("--port <n>", "gateway port (default: ephemeral)")
    .option("--portless", "route services through portless stable URLs (default; needs the proxy)")
    .option("--no-portless", "disable portless; use raw loopback ports (same as PORTLESS=0)")
    .option("--route", "enable Claude Code smart routing (scenario-based model selection)")
    .option("--route-dry-run", "with --route: print the routing decision and exit")
    .option("--route-preview <text>", "with --route-dry-run: sample prompt for scenario detection")
    .allowUnknownOption()
    .passThroughOptions();
}

/** Build the flag-only `RunFusionOptions` (no config/defaults applied yet). */
function resolveOptions(opts: FusionOpts): RunFusionOptions {
  const options: RunFusionOptions = {};
  const keyEnvs: Record<string, string> = {};
  for (const spec of opts.keyEnv ?? []) {
    const { id, value } = parseIdValue("--key-env", spec);
    keyEnvs[id] = value;
  }

  if (opts.judgeModel !== undefined) options.judgeModel = opts.judgeModel;
  if (opts.synthesisUrl !== undefined) options.synthesisUrl = opts.synthesisUrl;
  if (opts.fusionkitDir !== undefined) options.fusionkitDir = resolve(opts.fusionkitDir);
  if (opts.repo !== undefined) options.repo = resolve(opts.repo);
  // local/observe are tri-state: only set when the user passed --local/--no-local
  // (or --observe/--no-observe), so an unset flag can fall through to the config.
  if (opts.local !== undefined) options.local = opts.local;
  if (opts.observe !== undefined) options.observe = opts.observe;
  if (opts.yes === true) options.yes = true;
  if (opts.portless !== undefined) options.portless = opts.portless;
  if (opts.authToken !== undefined) options.authToken = opts.authToken;
  if (opts.port !== undefined) options.port = parsePort(opts.port, 0);

  const fusionkitDirEnv = process.env.FUSIONKIT_DIR ?? process.env.WARRANT_FUSIONKIT_DIR;
  if (options.fusionkitDir === undefined && fusionkitDirEnv !== undefined) {
    options.fusionkitDir = resolve(fusionkitDirEnv);
  }

  const modelSpecs = [...(opts.model ?? []), ...(opts.models ?? [])];
  if (modelSpecs.length > 0) {
    options.models = modelSpecs.map((spec) => parsePanelModelSpec(spec, keyEnvs));
  }

  const endpointSpecs = opts.modelEndpoint ?? [];
  if (endpointSpecs.length > 0) {
    const endpoints: Record<string, string> = {};
    for (const spec of endpointSpecs) {
      const { id, value } = parseIdValue("--model-endpoint", spec);
      endpoints[id] = value;
    }
    options.endpoints = endpoints;
    // Pre-running endpoints define the panel; ignore any --model specs.
    options.models = Object.keys(endpoints).map((id) => ({
      id,
      model: id,
      provider: "openai-compatible"
    }));
  }

  return options;
}

/** Fill any option the user did not set explicitly from `fusionkit.json`. */
function mergeConfig(options: RunFusionOptions, config: FusionConfig): void {
  if (options.models === undefined && options.endpoints === undefined && config.panel !== undefined && config.panel.length > 0) {
    options.models = config.panel.map((spec) => ({ ...spec }));
  }
  if (options.judgeModel === undefined && config.judgeModel !== undefined) options.judgeModel = config.judgeModel;
  if (options.local === undefined && config.local !== undefined) options.local = config.local;
  if (options.observe === undefined && config.observe !== undefined) options.observe = config.observe;
  if (options.portless === undefined && config.portless !== undefined) options.portless = config.portless;
  if (options.port === undefined && config.port != null) options.port = config.port;
  if (options.prompts === undefined && config.prompts !== undefined) options.prompts = config.prompts;
}

/** The repo root used for config lookup: --repo if given, else the cwd's git root. */
function configRepoRoot(options: RunFusionOptions): string | undefined {
  return options.repo ?? gitToplevel(process.cwd());
}

/**
 * Resolve options + the config-provided default tool. Flags always win over the
 * file; the file wins over built-in defaults.
 */
function resolveContext(opts: FusionOpts): { options: RunFusionOptions; configTool?: FusionTool } {
  const options = resolveOptions(opts);
  const repoRoot = configRepoRoot(options);
  let config: FusionConfig | undefined;
  if (repoRoot !== undefined) {
    try {
      config = loadFusionConfig(repoRoot);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (config !== undefined) mergeConfig(options, config);
  return { options, ...(config?.tool !== undefined ? { configTool: config.tool } : {}) };
}

export function registerFusion(program: Command): void {
  // Top-level `init` — scaffold a committed .fusionkit/ folder for this repo.
  program
    .command("init")
    .description("scaffold a committed .fusionkit/ folder for this repo")
    .option("--repo <dir>", "coding workspace the panel fuses over")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for default prompts)")
    .option("--force", "overwrite an existing .fusionkit/ config and prompts")
    .action(async (opts: FusionOpts) => {
      const options = resolveOptions(opts);
      const repoRoot = configRepoRoot(options);
      const code = await runFusionInit({
        repoRoot,
        force: opts.force === true,
        ...(options.fusionkitDir !== undefined ? { fusionkitDir: options.fusionkitDir } : {})
      });
      process.exit(code);
    });

  // Generic `fusion [tool]` — keeps the original surface and interactive pick.
  applyFusionOptions(
    program
      .command("fusion")
      .description("one command: real model fusion backs a coding agent")
      .argument("[tool]", `${FUSION_TOOLS.join(" | ")} | stop (omit on a TTY to pick interactively)`)
      .argument("[args...]", "arguments forwarded to the tool")
      .option("--tool <tool>", `coding agent to launch (${FUSION_TOOLS.join(" | ")})`)
  )
    .addHelpText(
      "after",
      "\nfusionkit's own flags must precede the tool name; everything after the tool is forwarded to it." +
        "\nRun `fusionkit init` to scaffold a committed .fusionkit/ folder for this repo." +
        "\nRun `fusionkit fusion stop` to reap portless singleton services (router, dashboard, ...)."
    )
    .action(async (positionalTool: string | undefined, args: string[], opts: FusionOpts) => {
      // `fusion stop` reaps persistent portless singletons left running by prior
      // runs (the router, dashboard, ...).
      if (positionalTool === "stop") {
        const stopped = await reapFusionServices((line) => console.error(line));
        console.error(`fusion: stopped ${stopped} portless service(s)`);
        process.exit(0);
      }

      const { options, configTool } = resolveContext(opts);
      let tool: FusionTool | undefined = opts.tool ? parseFusionTool(opts.tool) : undefined;
      let toolArgs = [...args];
      if (positionalTool !== undefined) {
        if (tool === undefined && (FUSION_TOOLS as readonly string[]).includes(positionalTool)) {
          tool = positionalTool as FusionTool;
        } else {
          toolArgs = [positionalTool, ...toolArgs];
        }
      }
      const resolvedTool = tool ?? configTool ?? (process.stdin.isTTY ? await pickTool() : "codex");
      if (resolvedTool === "claude" && (opts.route === true || opts.routeDryRun === true)) {
        const code = await runClaudeRoute(toolArgs, {
          ...options,
          dryRun: opts.routeDryRun === true,
          ...(opts.routePreview !== undefined ? { previewText: opts.routePreview } : {})
        });
        process.exit(code);
      }
      const code = await runFusion(resolvedTool, toolArgs, options);
      process.exit(code);
    });

  // Top-level shortcuts: `fusionkit codex`, `fusionkit claude`, etc.
  for (const tool of FUSION_TOOLS) {
    applyFusionOptions(
      program
        .command(tool)
        .description(`real model fusion backs ${tool === "serve" ? "any tool (prints setup snippets)" : tool}`)
        .argument("[args...]", `arguments forwarded to ${tool}`)
    )
      .addHelpText(
        "after",
        tool === "claude"
          ? `\nfusionkit's own flags must precede any ${tool} args; everything after is forwarded to ${tool}.` +
              "\nUse --route for Claude Code smart routing (scenario-based model selection)." +
              "\nUse --route-dry-run to preview the routing decision without starting Claude."
          : `\nfusionkit's own flags must precede any ${tool} args; everything after is forwarded to ${tool}.`
      )
      .action(async (args: string[], opts: FusionOpts) => {
        const { options } = resolveContext(opts);
        if (tool === "claude" && (opts.route === true || opts.routeDryRun === true)) {
          const code = await runClaudeRoute(args, {
            ...options,
            dryRun: opts.routeDryRun === true,
            ...(opts.routePreview !== undefined ? { previewText: opts.routePreview } : {})
          });
          process.exit(code);
        }
        const code = await runFusion(tool, args, options);
        process.exit(code);
      });
  }
}
