import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_MODEL_LABEL } from "@fusionkit/tools";
import { spawnTool } from "@routekit/runtime";
import type { FusedEnsembleInfo, ToolLaunchContext } from "@fusionkit/tools";

/**
 * opencode config registering the gateway as an OpenAI-compatible provider.
 * The fused model is listed first (the default) followed by every other fused
 * ensemble model and each native panel model, so opencode's picker offers them
 * all — the gateway routes a native pick to its real provider and a fused pick
 * to that ensemble's panel + judge.
 *
 * With `ensembles`, one `subagent`-mode agent per fusion ensemble is defined so
 * opencode's Task tool (and `@fusion-<name>` mentions) can delegate to any
 * ensemble out of the box. The agent map lives in the ephemeral config — the
 * user's own opencode config is untouched.
 */
export function opencodeConfig(
  gatewayUrl: string,
  model: string,
  nativeModels: readonly string[] = [],
  fusedModels: readonly string[] = [],
  ensembles: readonly FusedEnsembleInfo[] = []
): Record<string, unknown> {
  const models: Record<string, { name: string }> = { [model]: { name: model } };
  for (const id of [...fusedModels, ...nativeModels]) {
    if (id !== model) models[id] = { name: id };
  }
  const agent: Record<string, unknown> = {};
  for (const ensemble of ensembles) {
    const members = ensemble.memberIds.join(", ");
    const flavor = ensemble.modelId === model ? "default " : "";
    agent[ensemble.modelId] = {
      mode: "subagent",
      model: opencodeModelArg(ensemble.modelId),
      description:
        `Delegate a task to the ${flavor}"${ensemble.name}" fusion ensemble ` +
        `(${members} fused by a judge). Use when the user asks for the ${ensemble.name} ensemble.`,
      prompt:
        `You run on the fused "${ensemble.name}" ensemble; every reply is already a ` +
        "panel-and-judge fusion. Answer the delegated task directly and completely."
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [LOCAL_MODEL_LABEL]: {
        npm: "@ai-sdk/openai-compatible",
        name: "FusionKit local",
        options: { baseURL: `${gatewayUrl}/v1` },
        models
      }
    },
    ...(Object.keys(agent).length > 0 ? { agent } : {})
  };
}

/** The opencode `--model provider/model` argument for the gateway provider. */
export function opencodeModelArg(model: string): string {
  return `${LOCAL_MODEL_LABEL}/${model}`;
}

/** Boot opencode against the gateway via an ephemeral OPENCODE_CONFIG. */
export async function launchOpencode(ctx: ToolLaunchContext): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-opencode-"));
  ctx.registerDisposer(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "opencode.json");
  const ensembles = ctx.subagents !== false ? (ctx.fusedEnsembles ?? []) : [];
  writeFileSync(
    configPath,
    JSON.stringify(
      opencodeConfig(
        ctx.gatewayUrl,
        ctx.modelLabel,
        ctx.nativeModels ?? [],
        ctx.fusedModels ?? [],
        ensembles
      ),
      null,
      2
    )
  );
  const args = ctx.toolArgs.includes("--model")
    ? ctx.toolArgs
    : ["--model", opencodeModelArg(ctx.modelLabel), ...ctx.toolArgs];
  ctx.prepareForPassthrough();
  return await spawnTool("opencode", args, { OPENCODE_CONFIG: configPath }, ctx.repo);
}
