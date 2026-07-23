import { spawnTool } from "@velum-labs/routekit-runtime";
import type { AgentProfile, ToolLaunchContext } from "@velum-labs/routekit-tools";

export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? "routekit",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(process.env.CLAUDE_CONFIG_DIR !== undefined
      ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
      : {})
  };
}

function claudeModelId(modelId: string): string {
  const pickerId = modelId.startsWith("claude-code/")
    ? modelId.slice("claude-code/".length)
    : modelId;
  return pickerId.startsWith("claude") || pickerId.startsWith("anthropic")
    ? pickerId
    : `claude-${pickerId}`;
}

/** Serialize host-authored profiles once into Claude's session agent format. */
export function claudeAgentsJson(profiles: readonly AgentProfile[]): string {
  return JSON.stringify(
    Object.fromEntries(
      profiles.map((profile) => [
        profile.id,
        {
          description: profile.description,
          prompt: profile.instructions,
          model: claudeModelId(profile.model)
        }
      ])
    )
  );
}

function hasAgentsArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--agents" || arg.startsWith("--agents="));
}

function hasModelArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--model" || arg.startsWith("--model="));
}

export function claudeLaunchArgs(ctx: ToolLaunchContext): string[] {
  const args = [...ctx.spec.args];
  if (!hasModelArg(args)) {
    args.unshift("--model", claudeModelId(ctx.spec.defaultModel));
  }
  const profiles = ctx.spec.agentProfiles ?? [];
  if (profiles.length > 0 && !hasAgentsArg(args)) {
    args.push("--agents", claudeAgentsJson(profiles));
  }
  return args;
}

export async function launchClaude(ctx: ToolLaunchContext): Promise<number> {
  ctx.prepareForPassthrough();
  return await spawnTool(
    "claude",
    claudeLaunchArgs(ctx),
    claudeEnv(ctx.spec.gatewayUrl, ctx.spec.auth?.token),
    ctx.spec.cwd
  );
}
