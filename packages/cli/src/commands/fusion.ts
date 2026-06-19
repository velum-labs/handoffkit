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
  observe?: boolean;
  authToken?: string;
  port?: string;
};

export function registerFusion(program: Command): void {
  program
    .command("fusion")
    .description("one command: real model fusion backs a coding agent")
    .argument("[tool]", `${FUSION_TOOLS.join(" | ")} (omit on a TTY to pick interactively)`)
    .argument("[args...]", "arguments forwarded to the tool")
    .option("--tool <tool>", `coding agent to launch (${FUSION_TOOLS.join(" | ")})`)
    .option("--model <spec>", "panel model ID=MODEL or ID=PROVIDER:MODEL (repeatable)", collect)
    .option("--models <spec>", "alias of --model", collect)
    .option("--model-endpoint <spec>", "pre-running OpenAI-compatible endpoint ID=URL (repeatable)", collect)
    .option("--key-env <spec>", "env var holding a model's API key ID=ENV (repeatable)", collect)
    .option("--judge-model <model>", "model used for judge synthesis")
    .option("--synthesis-url <url>", "pre-running fusionkit serve for synthesis")
    .option("--fusionkit-dir <dir>", "FusionKit checkout (or WARRANT_FUSIONKIT_DIR)")
    .option("--repo <dir>", "coding workspace the panel fuses over")
    .option("--cursor-kit-dir <dir>", "built Cursorkit checkout for the cursor tool")
    .option("--observe", "boot the local scope dashboard and stream live trace events")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .option("--port <n>", "gateway port (default: ephemeral)")
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText(
      "after",
      "\nwarrant's own flags must precede the tool name; everything after the tool is forwarded to it."
    )
    .action(async (positionalTool: string | undefined, args: string[], opts: FusionOpts) => {
      const options: RunFusionOptions = {};
      const keyEnvs: Record<string, string> = {};
      for (const spec of opts.keyEnv ?? []) {
        const { id, value } = parseIdValue("--key-env", spec);
        keyEnvs[id] = value;
      }

      let tool: FusionTool | undefined = opts.tool ? parseFusionTool(opts.tool) : undefined;
      let toolArgs = [...args];
      if (positionalTool !== undefined) {
        if (tool === undefined && (FUSION_TOOLS as readonly string[]).includes(positionalTool)) {
          tool = positionalTool as FusionTool;
        } else {
          toolArgs = [positionalTool, ...toolArgs];
        }
      }

      if (opts.judgeModel !== undefined) options.judgeModel = opts.judgeModel;
      if (opts.synthesisUrl !== undefined) options.synthesisUrl = opts.synthesisUrl;
      if (opts.fusionkitDir !== undefined) options.fusionkitDir = resolve(opts.fusionkitDir);
      if (opts.repo !== undefined) options.repo = resolve(opts.repo);
      if (opts.cursorKitDir !== undefined) options.cursorKitDir = resolve(opts.cursorKitDir);
      if (opts.observe === true) options.observe = true;
      if (opts.authToken !== undefined) options.authToken = opts.authToken;
      if (opts.port !== undefined) options.port = parsePort(opts.port, 0);

      if (options.fusionkitDir === undefined && process.env.WARRANT_FUSIONKIT_DIR !== undefined) {
        options.fusionkitDir = resolve(process.env.WARRANT_FUSIONKIT_DIR);
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

      const resolvedTool = tool ?? (process.stdin.isTTY ? await pickTool() : "codex");
      const code = await runFusion(resolvedTool, toolArgs, options);
      process.exit(code);
    });
}
