import { LOCAL_MODEL_LABEL, spawnTool } from "@fusionkit/tools";
import type { FusedEnsembleInfo, ToolLaunchContext } from "@fusionkit/tools";

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

/**
 * The id a gateway model is selectable under inside Claude Code. Claude only
 * accepts ids beginning with `claude`/`anthropic`, so fused ensemble ids are
 * aliased with a `claude-` prefix — the same rule as the gateway's
 * `claudeModelAlias`, which strips the prefix back when routing.
 */
function claudeAliasedModelId(modelId: string): string {
  return modelId.startsWith("claude") || modelId.startsWith("anthropic")
    ? modelId
    : `claude-${modelId}`;
}

/**
 * The `--agents <json>` payload defining one session-scoped Claude sub-agent
 * per fusion ensemble (Task-tool delegation works out of the box; nothing is
 * written into the user's `.claude/`). Each agent pins its `model` to the
 * ensemble's `claude-`aliased gateway id.
 */
export function claudeAgentsJson(
  ensembles: readonly FusedEnsembleInfo[],
  defaultModelId: string
): string {
  const agents: Record<string, { description: string; prompt: string; model: string }> = {};
  for (const ensemble of ensembles) {
    const members = ensemble.memberIds.join(", ");
    const flavor = ensemble.modelId === defaultModelId ? "default " : "";
    agents[ensemble.modelId] = {
      description:
        `Delegate a task to the ${flavor}"${ensemble.name}" fusion ensemble ` +
        `(${members} fused by a judge). Use when the user asks for the ${ensemble.name} ensemble.`,
      prompt:
        `You run on the fused "${ensemble.name}" ensemble; every reply is already a ` +
        "panel-and-judge fusion. Answer the delegated task directly and completely.",
      model: claudeAliasedModelId(ensemble.modelId)
    };
  }
  return JSON.stringify(agents);
}

/** Whether the user already passed their own `--agents` (their definition wins). */
function hasUserAgentsArg(toolArgs: readonly string[]): boolean {
  return toolArgs.some((arg) => arg === "--agents" || arg.startsWith("--agents="));
}

/**
 * The final claude argv: the user's args plus, when sub-agent auto-provisioning
 * is on and the user did not pass their own `--agents`, one session-scoped
 * agent per fusion ensemble (see {@link claudeAgentsJson}).
 */
export function claudeLaunchArgs(
  ctx: Pick<ToolLaunchContext, "toolArgs" | "modelLabel" | "fusedEnsembles" | "subagents">
): string[] {
  const args = [...ctx.toolArgs];
  if (
    ctx.subagents !== false &&
    ctx.fusedEnsembles !== undefined &&
    ctx.fusedEnsembles.length > 0 &&
    !hasUserAgentsArg(args)
  ) {
    args.push("--agents", claudeAgentsJson(ctx.fusedEnsembles, ctx.modelLabel));
  }
  return args;
}

/** Boot the Claude Code CLI pointed at the gateway's Anthropic surface. */
export async function launchClaude(ctx: ToolLaunchContext): Promise<number> {
  ctx.prepareForPassthrough();
  if (ctx.mode === "fusion") {
    ctx.log("fusion: launching claude...");
  }
  // OOTB sub-agents: define one session-scoped agent per fusion ensemble so
  // Claude's Task tool can delegate to any ensemble. A user-supplied --agents
  // always wins; --no-subagents / `subagents: false` skips ours entirely.
  return await spawnTool("claude", claudeLaunchArgs(ctx), claudeEnv(ctx.gatewayUrl, ctx.authToken), ctx.repo);
}
