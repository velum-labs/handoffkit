import { resolve } from "node:path";

import type { Command } from "commander";

import { FUSION_TOOLS, pickTool, runFusion } from "../fusion-quickstart.js";
import type { FusionTool, RunFusionOptions } from "../fusion-quickstart.js";
import { collect, parseFusionTool, parseIdValue, parsePanelModelSpec, parsePort } from "../shared/options.js";

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
  cursorKitDir?: string;
  local?: boolean;
  observe?: boolean;
  authToken?: string;
  port?: string;
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
    .option("--cursor-kit-dir <dir>", "built Cursorkit checkout for the cursor tool")
    .option("--local", "use the local MLX panel trio instead of the default cloud panel")
    .option("--observe", "boot the local scope dashboard and stream live trace events")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .option("--port <n>", "gateway port (default: ephemeral)")
    .allowUnknownOption()
    .passThroughOptions();
}

/** Build the `RunFusionOptions` shared by every entrypoint from parsed flags. */
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
  if (opts.cursorKitDir !== undefined) options.cursorKitDir = resolve(opts.cursorKitDir);
  if (opts.local === true) options.local = true;
  if (opts.observe === true) options.observe = true;
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

export function registerFusion(program: Command): void {
  // Generic `fusion [tool]` — keeps the original surface and interactive pick.
  applyFusionOptions(
    program
      .command("fusion")
      .description("one command: real model fusion backs a coding agent")
      .argument("[tool]", `${FUSION_TOOLS.join(" | ")} (omit on a TTY to pick interactively)`)
      .argument("[args...]", "arguments forwarded to the tool")
      .option("--tool <tool>", `coding agent to launch (${FUSION_TOOLS.join(" | ")})`)
  )
    .addHelpText(
      "after",
      "\nfusionkit's own flags must precede the tool name; everything after the tool is forwarded to it."
    )
    .action(async (positionalTool: string | undefined, args: string[], opts: FusionOpts) => {
      let tool: FusionTool | undefined = opts.tool ? parseFusionTool(opts.tool) : undefined;
      let toolArgs = [...args];
      if (positionalTool !== undefined) {
        if (tool === undefined && (FUSION_TOOLS as readonly string[]).includes(positionalTool)) {
          tool = positionalTool as FusionTool;
        } else {
          toolArgs = [positionalTool, ...toolArgs];
        }
      }
      const options = resolveOptions(opts);
      const resolvedTool = tool ?? (process.stdin.isTTY ? await pickTool() : "codex");
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
        `\nfusionkit's own flags must precede any ${tool} args; everything after is forwarded to ${tool}.`
      )
      .action(async (args: string[], opts: FusionOpts) => {
        const options = resolveOptions(opts);
        const code = await runFusion(tool, args, options);
        process.exit(code);
      });
  }
}
