import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

/**
 * Environment for Claude Code: point it at the gateway's Anthropic surface and
 * turn on gateway model discovery so the `/model` picker is populated from the
 * gateway's `/v1/models`. The gateway lists every panel model there (aliasing
 * non-Anthropic ids past Claude Code's `claude`/`anthropic` picker filter), so
 * the fused model and each native are all selectable; the gateway maps the
 * alias back when routing.
 */
export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    // A token must be present or gateway discovery silently no-ops (it guards on
    // having an auth token / api key before fetching `/v1/models`).
    ANTHROPIC_AUTH_TOKEN: authToken ?? LOCAL_MODEL_LABEL,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

/** Boot the Claude Code CLI pointed at the gateway's Anthropic surface. */
export async function launchClaude(ctx: ToolLaunchContext): Promise<number> {
  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching claude...");
  }
  return await spawnTool("claude", ctx.toolArgs, claudeEnv(ctx.gatewayUrl, ctx.authToken), ctx.repo);
}
