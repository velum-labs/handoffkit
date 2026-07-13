import { resolve } from "node:path";

import type { Command } from "commander";

import { dim, uiStream } from "@fusionkit/cli-ui";

import { DEFAULT_REASONING_MODEL, FUSION_TOOLS, gitToplevel, pickTool, runFusion } from "../fusion-quickstart.js";
import type { FusionTool, RunFusionOptions } from "../fusion-quickstart.js";
import { loadFusionConfig } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { runDirect } from "../local.js";
import { configDefaultEnsembleName } from "../fusion/effective-config.js";
import { runFusionInit } from "../fusion-init.js";
import { toolRegistry } from "../tools.js";
import { contextFor } from "../shared/context.js";
import { fail } from "../shared/errors.js";
import { warnPassthroughTypos } from "../shared/flag-suggest.js";

import { registerPaletteAction } from "./palette.js";
import { runFusionStop } from "./stop.js";
import {
  collect,
  parseBudget,
  parseFusionTool,
  parseIdValue,
  parseK,
  parseOnRateLimit,
  parsePanelModelSpec,
  parsePanelTrust,
  parsePort
} from "../shared/options.js";

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
  direct?: boolean;
  publicUrl?: string;
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
  expose?: boolean;
  onRateLimit?: string;
  budget?: string;
  panelTrust?: string;
  k?: string;
  resume?: string;
  continue?: boolean;
};

const DIRECT_TOOLS: readonly string[] = [
  ...toolRegistry.launchableLocal().map((tool) => tool.id),
  "serve"
];

const TOP_LEVEL_TOOLS: readonly string[] = [
  ...FUSION_TOOLS,
  ...DIRECT_TOOLS.filter((tool) => !(FUSION_TOOLS as readonly string[]).includes(tool))
];

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
    .option("--direct", "back the tool with one local model directly (no panel, judge, or synthesis)")
    .option("--public-url <url>", "direct Cursor mode only: public tunnel URL (or FUSIONKIT_PUBLIC_URL)")
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
      "--expose",
      "serve only: publish the gateway on a public HTTPS tunnel (Cloudflare Quick Tunnel) with a required bearer token — e.g. for Cursor BYOK"
    )
    .option(
      "--on-rate-limit <policy>",
      "vendor rate-limit/credit handoff: fusion (rerun the turn on the ensemble minus the throttled vendor, default) | passthrough (return the vendor error as-is) | fail (stop the session)"
    )
    .option("--budget <usd>", "stop the session once it has spent this much (gateway-observed USD)")
    .option(
      "--panel-trust <level>",
      "panel model sandbox: full = models may run any command and edit any file (default) | " +
        "guarded = each model may only edit inside its own draft worktree"
    )
    .option(
      "--k <n>",
      "step boundaries per panel member before aggregation: 1 = single-completion proposers " +
        "(caller executes the adopted step), n > 1 = bounded managed rollout, unset = full rollout (default)"
    )
    .option("--resume <id>", "resume a stored session by id (or unique prefix); see `fusionkit sessions`")
    .option("--continue", "resume the most recently active stored session")
    .allowUnknownOption()
    .passThroughOptions();
}

async function launchDirect(
  tool: string,
  args: string[],
  opts: FusionOpts,
  command: Command
): Promise<number> {
  if (opts.local !== undefined) {
    fail("--direct cannot be combined with --local or --no-local; direct mode always uses one local model");
  }
  if (opts.expose === true) {
    fail("--expose is unavailable with --direct; use --public-url for Cursor");
  }
  if (tool !== "serve" && !DIRECT_TOOLS.includes(tool)) {
    fail(`${tool} does not support --direct`);
  }
  const ctx = contextFor(command);
  return await runDirect(tool, args, {
    log: (line) => ctx.presenter.note(line),
    ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
    ...(opts.ide === true ? { ide: true } : {}),
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {})
  });
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
  if (opts.expose === true) options.expose = true;
  const onRateLimit = parseOnRateLimit(opts.onRateLimit);
  if (onRateLimit !== undefined) options.onRateLimit = onRateLimit;
  const budgetUsd = parseBudget(opts.budget);
  if (budgetUsd !== undefined) options.budgetUsd = budgetUsd;
  const panelTrust = parsePanelTrust(opts.panelTrust);
  if (panelTrust !== undefined) options.panelTrust = panelTrust;
  const k = parseK(opts.k);
  if (k !== undefined) options.k = k;
  if (opts.authToken !== undefined) options.authToken = opts.authToken;
  if (opts.port !== undefined) options.port = parsePort(opts.port, 0);
  if (opts.resume !== undefined) options.resume = opts.resume;
  if (opts.continue === true) options.continueLatest = true;

  const fusionkitDirEnv = process.env.FUSIONKIT_DIR;
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
    options.ensembles = Object.entries(config.ensembles).map(([name, ensemble]) => {
      // Per-ensemble k falls back to the config's top-level default.
      const k = ensemble.k ?? config.k;
      return {
        name,
        models: (ensemble.panel ?? []).map((spec) => ({ ...spec })),
        ...(ensemble.judgeModel !== undefined ? { judgeModel: ensemble.judgeModel } : {}),
        ...(ensemble.synthesizerModel !== undefined ? { synthesizerModel: ensemble.synthesizerModel } : {}),
        ...(k !== undefined ? { k } : {}),
        ...(ensemble.prompts !== undefined ? { prompts: ensemble.prompts } : {})
      };
    });
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
  if (options.subscriptionAccounts === undefined && config.subscriptionAccounts !== undefined) {
    options.subscriptionAccounts = config.subscriptionAccounts;
  }
  if (options.budgetUsd === undefined && config.budgetUsd !== undefined) {
    options.budgetUsd = config.budgetUsd;
  }
  if (options.panelTrust === undefined && config.panelTrust !== undefined) {
    options.panelTrust = config.panelTrust;
  }
  if (options.k === undefined && config.k !== undefined) options.k = config.k;
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
    { label: "Stop background fusion services", hint: "fusionkit stop", argv: ["stop"] }
  );

  // Top-level shortcuts: `fusionkit codex`, `fusionkit claude`, etc.
  for (const tool of TOP_LEVEL_TOOLS) {
    const supportsFusion = (FUSION_TOOLS as readonly string[]).includes(tool);
    applyFusionOptions(
      program
        .command(tool)
        .description(
          supportsFusion
            ? `real model fusion backs ${tool === "serve" ? "any tool (prints setup snippets)" : tool}`
            : `back ${tool} with one local model directly (--direct required)`
        )
        .argument("[args...]", `arguments forwarded to ${tool}`)
    )
      .addHelpText(
        "after",
        `\nfusionkit's own flags must precede any ${tool} args; everything after is forwarded to ${tool}.`
      )
      .action(async (args: string[], _opts: FusionOpts, command: Command) => {
        const opts = command.optsWithGlobals<FusionOpts>();
        warnPassthroughTypos(command, args, tool);
        if (opts.direct === true) {
          process.exitCode = await launchDirect(tool, args, opts, command);
          return;
        }
        if (opts.publicUrl !== undefined) {
          fail("--public-url requires --direct");
        }
        if (!supportsFusion) {
          fail(`${tool} only supports direct mode; run \`fusionkit ${tool} --direct\``);
        }
        const { options } = resolveContext(opts);
        if (options.expose === true && tool !== "serve") {
          fail("--expose only applies to `fusionkit serve` (launched agents reach the gateway on loopback)");
        }
        const code = await runFusion(tool, args, options);
        process.exitCode = code;
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
        process.exitCode = await runFusionStop();
        return;
      }

      const { options, configTool } = resolveContext(opts);
      let tool: FusionTool | undefined = opts.tool ? parseFusionTool(opts.tool) : undefined;
      let toolArgs = [...args];
      if (positionalTool !== undefined) {
        const positionalIsTool =
          (FUSION_TOOLS as readonly string[]).includes(positionalTool) ||
          (opts.direct === true && DIRECT_TOOLS.includes(positionalTool));
        if (tool === undefined && positionalIsTool) {
          tool = positionalTool as FusionTool;
        } else {
          toolArgs = [positionalTool, ...toolArgs];
        }
      }
      const resolvedTool = tool ?? configTool ?? (process.stdin.isTTY ? await pickTool() : "codex");
      warnPassthroughTypos(command, toolArgs, resolvedTool);
      if (opts.direct === true) {
        process.exitCode = await launchDirect(resolvedTool, toolArgs, opts, command);
        return;
      }
      if (opts.publicUrl !== undefined) {
        fail("--public-url requires --direct");
      }
      if (options.expose === true && resolvedTool !== "serve") {
        fail("--expose only applies to `fusionkit serve` (launched agents reach the gateway on loopback)");
      }
      const code = await runFusion(resolvedTool, toolArgs, options);
      process.exitCode = code;
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
      process.exitCode = code;
    });
}
