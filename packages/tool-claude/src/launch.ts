import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

/** Environment for Claude Code: point it at the gateway's Anthropic surface. */
export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? LOCAL_MODEL_LABEL,
    // Surface the local model in the /model picker (Anthropic discovery).
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
