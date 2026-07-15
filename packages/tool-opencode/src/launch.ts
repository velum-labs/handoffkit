import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerOptions } from "@opencode-ai/sdk/server";
import { spawnTool } from "@routekit/runtime";
import type { ToolLaunchContext, ToolLaunchSpec } from "@routekit/tools";

const PROVIDER_ID = "routekit";
type OpencodeServerConfig = NonNullable<ServerOptions["config"]>;

export function opencodeModelArg(model: string): string {
  return `${PROVIDER_ID}/${model}`;
}

/** Serialize one neutral routed provider for launchers and driver instances. */
export function opencodeProviderConfig(
  spec: Pick<ToolLaunchSpec, "gatewayUrl" | "models" | "agentProfiles" | "auth">
): OpencodeServerConfig {
  const models = Object.fromEntries(
    spec.models.flatMap((model) => [
      [model.id, { name: model.label ?? model.id }],
      ...(model.aliases ?? []).map((alias) => [alias, { name: alias }])
    ])
  );
  const agent = Object.fromEntries(
    (spec.agentProfiles ?? []).map((profile) => [
      profile.id,
      {
        mode: "subagent" as const,
        model: opencodeModelArg(profile.model),
        description: profile.description,
        prompt: profile.instructions
      }
    ])
  );
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "RouteKit gateway",
        options: {
          baseURL: `${spec.gatewayUrl.replace(/\/+$/, "")}/v1`,
          ...(spec.auth?.token !== undefined ? { apiKey: spec.auth.token } : {})
        },
        models
      }
    },
    ...(Object.keys(agent).length > 0 ? { agent } : {})
  };
}

/** Serialize the neutral model catalog and profiles into OpenCode JSON. */
export function opencodeConfig(spec: ToolLaunchSpec): OpencodeServerConfig {
  return opencodeProviderConfig(spec);
}

export async function launchOpencode(ctx: ToolLaunchContext): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "routekit-opencode-"));
  ctx.registerDisposer(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, JSON.stringify(opencodeConfig(ctx.spec), null, 2));
  const args = ctx.spec.args.includes("--model")
    ? [...ctx.spec.args]
    : ["--model", opencodeModelArg(ctx.spec.defaultModel), ...ctx.spec.args];
  ctx.prepareForPassthrough();
  return await spawnTool("opencode", args, { OPENCODE_CONFIG: configPath }, ctx.spec.cwd);
}
