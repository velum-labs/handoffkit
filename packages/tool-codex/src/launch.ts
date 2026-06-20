import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

/**
 * Codex config.toml fragment defining the gateway as a Responses provider.
 * Written into an ephemeral CODEX_HOME so the user's own config is untouched.
 * (This is the launcher shim; the harness has its own richer config builder.)
 */
export function codexLaunchConfigToml(gatewayUrl: string, model: string): string {
  return [
    `model = "${model}"`,
    `model_provider = "${LOCAL_MODEL_LABEL}"`,
    "",
    `[model_providers.${LOCAL_MODEL_LABEL}]`,
    `name = "FusionKit local"`,
    `base_url = "${gatewayUrl}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ""
  ].join("\n");
}

/** Boot the Codex CLI against the gateway via an ephemeral CODEX_HOME. */
export async function launchCodex(ctx: ToolLaunchContext): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "fusionkit-codex-"));
  writeFileSync(join(home, "config.toml"), codexLaunchConfigToml(ctx.gatewayUrl, ctx.modelLabel));
  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching codex (each prompt is a coding task fused across the panel)...");
  }
  return await spawnTool("codex", ctx.toolArgs, { CODEX_HOME: home }, ctx.repo);
}
