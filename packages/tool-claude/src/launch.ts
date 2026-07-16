import { spawnTool } from "@routekit/runtime";
import type { AgentProfile, ToolLaunchContext } from "@routekit/tools";

export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? "routekit",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

function claudeModelId(modelId: string): string {
  return modelId.startsWith("claude") || modelId.startsWith("anthropic")
    ? modelId
    : `claude-${modelId}`;
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
