import { resolve } from "node:path";

import { contextFor, fail } from "@velum-labs/routekit-cli-core";
import type { Command } from "commander";

import type { FusionTool } from "@fusionkit/config";
import {
  FUSION_TOOLS,
  gitToplevel,
  runFusion
} from "../fusion-quickstart.js";
import type { RunFusionOptions } from "../fusion-quickstart.js";
import { loadFusionConfig } from "../fusion-config.js";
import { runFusionInit } from "../fusion-init.js";
import { parseBudget, parseK, parseOnRateLimit, parsePanelTrust, parsePort } from "../shared/options.js";
import { registerPaletteAction } from "./palette.js";

type FusionOpts = {
  ensemble?: string;
  fusionkitDir?: string;
  repo?: string;
  observe?: boolean;
  reasoning?: boolean;
  effort?: string;
  subagents?: boolean;
  authToken?: string;
  port?: string;
  portless?: boolean;
  ide?: boolean;
  onRateLimit?: string;
  budget?: string;
  panelTrust?: string;
  k?: string;
  resume?: string;
  continue?: boolean;
  force?: boolean;
};

function repoRoot(options: FusionOpts): string | undefined {
  return options.repo !== undefined
    ? resolve(options.repo)
    : gitToplevel(process.cwd());
}

function resolveContext(options: FusionOpts): RunFusionOptions {
  const root = repoRoot(options);
  if (root === undefined) {
    fail("not inside a git repository; cd into a repo or pass --repo <dir>");
  }
  const config = loadFusionConfig(root);
  if (config === undefined) {
    fail(`no .fusionkit/fusion.json found in ${root}; run \`fusionkit init\``);
  }
  const run: RunFusionOptions = {
    repo: root,
    router: config.router,
    ensembles: Object.entries(config.ensembles).map(([name, ensemble]) => ({
      name,
      members: [...ensemble.members],
      judge: ensemble.judge,
      ...(ensemble.synthesizer !== undefined
        ? { synthesizer: ensemble.synthesizer }
        : {}),
      ...((ensemble.k ?? config.k) !== undefined
        ? { k: ensemble.k ?? config.k }
        : {}),
      ...(ensemble.prompts !== undefined ? { prompts: ensemble.prompts } : {})
    })),
    ensemble: options.ensemble ?? config.defaultEnsemble,
    observe: options.observe ?? config.observe,
    reasoning: options.reasoning ?? config.reasoning,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    subagents: options.subagents ?? config.subagents,
    portless: options.portless ?? config.portless,
    onRateLimit: parseOnRateLimit(options.onRateLimit) ?? config.onRateLimit,
    budgetUsd: parseBudget(options.budget) ?? config.budgetUsd,
    panelTrust: parsePanelTrust(options.panelTrust) ?? config.panelTrust,
    k: parseK(options.k),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    ...(options.port !== undefined
      ? { port: parsePort(options.port, 0) }
      : config.port != null
        ? { port: config.port }
        : {}),
    ...(options.ide === true ? { ide: true } : {}),
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    ...(options.continue === true ? { continueLatest: true } : {}),
    ...(options.fusionkitDir !== undefined
      ? { fusionkitDir: resolve(options.fusionkitDir) }
      : process.env.FUSIONKIT_DIR !== undefined
        ? { fusionkitDir: resolve(process.env.FUSIONKIT_DIR) }
        : {})
  };
  return run;
}

function applyFusionOptions(command: Command): Command {
  return command
    .option("--ensemble <name>", "session-default configured ensemble")
    .option("--fusionkit-dir <dir>", "local FusionKit Python checkout")
    .option("--repo <dir>", "coding workspace")
    .option("--observe", "boot the local observability dashboard")
    .option("--no-observe", "disable the observability dashboard")
    .option("--reasoning", "stream fusion reasoning progress")
    .option("--no-reasoning", "disable reasoning progress")
    .option("--effort <id>", "opaque reasoning effort forwarded to panel calls")
    .option("--subagents", "create one generic agent profile per ensemble")
    .option("--no-subagents", "do not create agent profiles")
    .option("--auth-token <token>", "require authentication on the Fusion gateway")
    .option("--port <n>", "Fusion gateway port")
    .option("--portless", "use Fusion-owned portless routes")
    .option("--no-portless", "disable Fusion-owned portless routes")
    .option("--ide", "Cursor only: launch the desktop integration")
    .option("--on-rate-limit <policy>", "fusion | passthrough | fail")
    .option("--budget <usd>", "session budget in USD")
    .option("--panel-trust <level>", "full | guarded")
    .option("--k <n>", "step boundaries per panel member")
    .option("--resume <id>", "resume a Fusion session")
    .option("--continue", "resume the latest Fusion session");
}

export function registerFusion(program: Command): void {
  registerPaletteAction(
    ...FUSION_TOOLS.map((tool) => ({
      label: `Run ${tool} with fusion`,
      hint: `fusionkit ${tool}`,
      argv: [tool]
    })),
    { label: "Set up this repo", hint: "fusionkit init", argv: ["init"] }
  );
  for (const tool of FUSION_TOOLS) {
    applyFusionOptions(
      program
        .command(tool)
        .description(
          tool === "serve"
            ? "serve configured fusion ensembles"
            : `launch ${tool} with configured fusion ensembles`
        )
        .argument("[args...]", `arguments forwarded to ${tool}`)
    ).action(async (args: string[], _opts: FusionOpts, command: Command) => {
      if (tool === "serve" && args.length > 0) {
        fail("fusionkit serve does not accept passthrough arguments");
      }
      if (tool !== "serve" && contextFor(command).json) {
        fail(`\`${tool}\` is interactive and does not support --json`);
      }
      const options = command.optsWithGlobals<FusionOpts>();
      const runOptions = resolveContext(options);
      if (contextFor(command).json) runOptions.json = true;
      process.exitCode = await runFusion(
        tool as FusionTool,
        args,
        runOptions
      );
    });
  }
  program
    .command("init")
    .description("scaffold .fusionkit/fusion.json from namespaced RouteKit model ids")
    .option("--repo <dir>", "repository root")
    .option("--force", "replace an existing Fusion config")
    .action(async (options: FusionOpts) => {
      process.exitCode = await runFusionInit({
        repoRoot: repoRoot(options),
        force: options.force === true
      });
    });
}
