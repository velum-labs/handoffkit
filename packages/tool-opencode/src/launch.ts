import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

/**
 * opencode config registering the gateway as an OpenAI-compatible provider.
 * The fused model is listed first (the default) followed by each native panel
 * model, so opencode's picker offers both — the gateway routes a native pick to
 * its real provider and a fused pick to the panel + judge.
 */
export function opencodeConfig(
  gatewayUrl: string,
  model: string,
  nativeModels: readonly string[] = []
): Record<string, unknown> {
  const models: Record<string, { name: string }> = { [model]: { name: model } };
  for (const native of nativeModels) {
    if (native !== model) models[native] = { name: native };
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
    }
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
  writeFileSync(
    configPath,
    JSON.stringify(opencodeConfig(ctx.gatewayUrl, ctx.modelLabel, ctx.nativeModels ?? []), null, 2)
  );
  const args = ctx.toolArgs.includes("--model")
    ? ctx.toolArgs
    : ["--model", opencodeModelArg(ctx.modelLabel), ...ctx.toolArgs];
  ctx.prepareForPassthrough();
  return await spawnTool("opencode", args, { OPENCODE_CONFIG: configPath }, ctx.repo);
}
