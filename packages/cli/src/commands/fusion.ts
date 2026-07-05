import { resolve } from "node:path";

import type { Command } from "commander";

import { dim, done, note, uiStream } from "@fusionkit/cli-ui";

import { DEFAULT_REASONING_MODEL, FUSION_TOOLS, gitToplevel, pickTool, runFusion } from "../fusion-quickstart.js";
import type { FusionTool, RunFusionOptions } from "../fusion-quickstart.js";
import { loadFusionConfig } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { configDefaultEnsembleName } from "../fusion/effective-config.js";
import { runFusionInit } from "../fusion-init.js";
import { toolRegistry } from "../tools.js";
import { fail } from "../shared/errors.js";
import { warnPassthroughTypos } from "../shared/flag-suggest.js";

import { registerPaletteAction } from "./palette.js";
import {
  collect,
  parseBudget,
  parseFusionTool,
  parseIdValue,
  parseOnRateLimit,
  parsePanelModelSpec,
  parsePanelTrust,
  parsePort
} from "../shared/options.js";
import { reapFusionServices } from "../shared/portless.js";

type FusionOpts = {
  tool?: string;
  model?: string[];
  models?: string[];
  modelEndpoint?: string[];
  keyEnv?: string[];
  ensemble?: string;
  judgeModel?: string;
  synthesisUrl?: string;
  fusionkitDir?: string;
  repo?: string;
  local?: boolean;
  observe?: boolean;
  reasoning?: boolean;
  reasoningModel?: string | boolean;
  yes?: boolean;
  force?: boolean;
  subagents?: boolean;
  authToken?: string;
  port?: string;
  portless?: boolean;
  ide?: boolean;
  onRateLimit?: string;
  budget?: string;
  panelTrust?: string;
  resume?: string;
  continue?: boolean;
};

/** Attach the panel/gateway flags shared by `fusion` and the per-tool launchers. */
function applyFusionOptions(command: Command): Command {
  return command
    .option("--model <spec>", "panel model ID=MODEL or ID=PROVIDER:MODEL (repeatable)", collect)
    .option("--models <spec>", "alias of --model", collect)
    .option("--model-endpoint <spec>", "pre-running OpenAI-compatible endpoint ID=URL (repeatable)", collect)
    .option("--key-env <spec>", "env var holding a model's API key ID=ENV (repeatable)", collect)
    .option(
      "--ensemble <name>",
      "the session-default ensemble from .fusionkit/fusion.json (every defined ensemble is still registered as its own model)"
    )
    .option("--judge-model <model>", "model used for judge synthesis")
    .option("--synthesis-url <url>", "pre-running fusionkit serve for synthesis")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for the uvx synthesizer)")
    .option("--repo <dir>", "coding workspace the panel fuses over")
    .option("--local", "run the panel on local MLX models (Apple Silicon only) instead of cloud providers")
    .option("--no-local", "override a .fusionkit default of local=true")
    .option("--observe", "boot the local scope dashboard and stream live trace events")
    .option("--no-observe", "override a .fusionkit default of observe=true")
    .option("--reasoning", "narrate panel/judge progress in the tool's thinking UI (default)")
    .option("--no-reasoning", "keep the stream silent until the judge's first token")
    .option(
      "--reasoning-model [model]",
      "write narration prose with a model: a panel member, provider/model " +
        `(e.g. openai/gpt-5.5-mini), or a local MLX repo (default: ${DEFAULT_REASONING_MODEL}; Apple Silicon)`
    )
    .option("--yes", "skip the interactive cloud-panel cost confirmation")
    .option("--subagents", "auto-provision one native sub-agent per ensemble in the launched tool (default)")
    .option("--no-subagents", "skip sub-agent auto-provisioning (Codex roles, Claude --agents, agent file scaffolds)")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .option("--port <n>", "gateway port (default: ephemeral)")
    .option("--portless", "route services through portless stable URLs (default; needs the proxy)")
    .option("--no-portless", "disable portless; use raw loopback ports (same as PORTLESS=0)")
    .option("--ide", "Cursor only: wire the Cursor IDE to the gateway (local desktop proxy, no tunnel)")
    .option(
      "--on-rate-limit <policy>",
      "vendor rate-limit/credit handoff: fusion (continue on the ensemble, default) | passthrough | fail"
    )
    .option("--budget <usd>", "stop the session once it has spent this much (gateway-observed USD)")
    .option(
      "--panel-trust <level>",
      "panel candidate autonomy: full (max, default) | guarded (harness-fenced to the worktree)"
    )
    .option("--resume <id>", "resume a stored session by id (or unique prefix); see `fusionkit sessions`")
    .option("--continue", "resume the most recently active stored session")
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

  if (opts.ensemble !== undefined) options.ensemble = opts.ensemble;
  if (opts.judgeModel !== undefined) options.judgeModel = opts.judgeModel;
  if (opts.synthesisUrl !== undefined) options.synthesisUrl = opts.synthesisUrl;
  if (opts.fusionkitDir !== undefined) options.fusionkitDir = resolve(opts.fusionkitDir);
  if (opts.repo !== undefined) options.repo = resolve(opts.repo);
  // local/observe/reasoning are tri-state: only set when the user passed the
  // flag (or its --no- form), so an unset flag can fall through to the config.
  if (opts.local !== undefined) options.local = opts.local;
  if (opts.observe !== undefined) options.observe = opts.observe;
  if (opts.reasoning !== undefined) options.reasoning = opts.reasoning;
  // `--reasoning-model` without a value means "use the benchmark default".
  if (opts.reasoningModel !== undefined) {
    options.reasoningModel = opts.reasoningModel === true ? DEFAULT_REASONING_MODEL : String(opts.reasoningModel);
  }
  if (opts.yes === true) options.yes = true;
  // subagents is tri-state: only set when the user passed the flag (or its
  // --no- form), so an unset flag can fall through to the config.
  if (opts.subagents !== undefined) options.subagents = opts.subagents;
  if (opts.portless !== undefined) options.portless = opts.portless;
  if (opts.ide === true) options.ide = true;
  const onRateLimit = parseOnRateLimit(opts.onRateLimit);
  if (onRateLimit !== undefined) options.onRateLimit = onRateLimit;
  const budgetUsd = parseBudget(opts.budget);
  if (budgetUsd !== undefined) options.budgetUsd = budgetUsd;
  const panelTrust = parsePanelTrust(opts.panelTrust);
  if (panelTrust !== undefined) options.panelTrust = panelTrust;
  if (opts.authToken !== undefined) options.authToken = opts.authToken;
  if (opts.port !== undefined) options.port = parsePort(opts.port, 0);
  if (opts.resume !== undefined) options.resume = opts.resume;
  if (opts.continue === true) options.continueLatest = true;

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

/** Fill any option the user did not set explicitly from `.fusionkit/fusion.json`. */
function mergeConfig(options: RunFusionOptions, config: FusionConfig): void {
  // Named ensembles: every defined ensemble flows through (each registers as
  // its own gateway model); `--ensemble` (or the config's defaultEnsemble)
  // picks the session default. Flag `--model`/`--judge-model` overrides apply
  // to the selected ensemble inside `runFusion`.
  if (
    options.ensembles === undefined &&
    options.endpoints === undefined &&
    config.ensembles !== undefined &&
    Object.keys(config.ensembles).length > 0
  ) {
    options.ensembles = Object.entries(config.ensembles).map(([name, ensemble]) => ({
      name,
      models: (ensemble.panel ?? []).map((spec) => ({ ...spec })),
      ...(ensemble.judgeModel !== undefined ? { judgeModel: ensemble.judgeModel } : {}),
      ...(ensemble.synthesizerModel !== undefined ? { synthesizerModel: ensemble.synthesizerModel } : {}),
      ...(ensemble.prompts !== undefined ? { prompts: ensemble.prompts } : {})
    }));
    if (options.ensemble === undefined) {
      const configured = configDefaultEnsembleName(config);
      if (configured !== undefined) options.ensemble = configured;
    }
  }
  if (options.local === undefined && config.local !== undefined) options.local = config.local;
  if (options.observe === undefined && config.observe !== undefined) options.observe = config.observe;
  if (options.reasoning === undefined && config.reasoning !== undefined) options.reasoning = config.reasoning;
  if (options.reasoningModel === undefined && config.reasoningModel !== undefined) {
    options.reasoningModel = config.reasoningModel;
  }
  if (options.portless === undefined && config.portless !== undefined) options.portless = config.portless;
  if (options.port === undefined && config.port != null) options.port = config.port;
  if (options.onRateLimit === undefined && config.onRateLimit !== undefined) {
    options.onRateLimit = config.onRateLimit;
  }
  if (options.budgetUsd === undefined && config.budgetUsd !== undefined) {
    options.budgetUsd = config.budgetUsd;
  }
  if (options.panelTrust === undefined && config.panelTrust !== undefined) {
    options.panelTrust = config.panelTrust;
  }
  if (options.subagents === undefined && config.subagents !== undefined) {
    options.subagents = config.subagents;
  }
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
  registerPaletteAction(
    ...toolRegistry.launchableFusion().map((tool) => ({
      label: `Run ${tool.id} with fusion`,
      hint: `fusionkit ${tool.id}`,
      argv: [tool.id]
    })),
    { label: "Run the gateway for any tool", hint: "fusionkit serve", argv: ["serve"] },
    { label: "Set up this repo (.fusionkit/)", hint: "fusionkit init", argv: ["init"] },
    { label: "Stop background fusion services", hint: "fusionkit fusion stop", argv: ["fusion", "stop"] }
  );

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
        `\nfusionkit's own flags must precede any ${tool} args; everything after is forwarded to ${tool}.`
      )
      .action(async (args: string[], _opts: FusionOpts, command: Command) => {
        const opts = command.optsWithGlobals<FusionOpts>();
        warnPassthroughTypos(command, args, tool);
        const { options } = resolveContext(opts);
        const code = await runFusion(tool, args, options);
        process.exit(code);
      });
  }

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
    .action(async (positionalTool: string | undefined, args: string[], _opts: FusionOpts, command: Command) => {
      // Merge program-level flags (--yes and friends may precede `fusion`).
      const opts = command.optsWithGlobals<FusionOpts>();
      // `fusion stop` reaps persistent portless singletons left running by prior
      // runs (the router, dashboard, ...).
      if (positionalTool === "stop") {
        const stopped = await reapFusionServices((line) => uiStream().write(`${dim(line)}\n`));
        if (stopped === 0) note("no background fusion services were running");
        else done(`stopped ${stopped} background fusion service(s)`);
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
      warnPassthroughTypos(command, toolArgs, resolvedTool);
      const code = await runFusion(resolvedTool, toolArgs, options);
      process.exit(code);
    });

  // Top-level `init` — scaffold a committed .fusionkit/ folder for this repo.
  program
    .command("init")
    .description("scaffold a committed .fusionkit/ folder for this repo")
    .option("--repo <dir>", "coding workspace the panel fuses over")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for default prompts)")
    .option("--force", "overwrite an existing .fusionkit/ config and prompts without prompting")
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
}
