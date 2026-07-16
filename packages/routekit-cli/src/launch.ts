import { toolRegistry as routekitToolRegistry } from "@routekit/tool-registry";
import { resolveModelId } from "@routekit/config";
import { createToolLaunchContext } from "@routekit/tools";
import type {
  ToolIntegration,
  ToolLaunchSpec,
  ToolModel,
  ToolModelFeatureStatus
} from "@routekit/tools";
import type { RouterConfig } from "@routekit/gateway";
import { commandOnPath } from "@routekit/runtime";

import { fetchLiveCatalog, type LiveModel } from "./catalog.js";
import { startRouter } from "./serve.js";

export { routekitToolRegistry };

function featureStatus(status: string | undefined): ToolModelFeatureStatus {
  switch (status) {
    case "supported":
      return "full";
    case "degraded":
      return "degraded";
    case "unsupported":
      return "unsupported";
    case "unknown":
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function liveModels(models: readonly LiveModel[]): ToolModel[] {
  return models.map((model) => {
    return {
      id: model.id,
      label: model.id,
      features: {
        streaming: featureStatus(model.capabilities.streaming),
        tools: featureStatus(model.capabilities.tools),
        images: featureStatus(model.capabilities.images),
        reasoning_controls: featureStatus(
          model.capabilities.reasoning_controls
        )
      }
    };
  });
}

export function buildToolLaunchSpec(input: {
  config: RouterConfig;
  catalog: readonly LiveModel[];
  gatewayUrl: string;
  model?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  ide?: boolean;
}): ToolLaunchSpec {
  const models = liveModels(input.catalog);
  const defaultModel = resolveModelId(
    input.config,
    models.map((model) => model.id),
    input.model
  );
  return {
    gatewayUrl: input.gatewayUrl,
    defaultModel,
    models,
    args: input.args ?? [],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.authToken !== undefined ? { auth: { token: input.authToken } } : {}),
    ...(input.ide !== undefined ? { ide: input.ide } : {})
  };
}

export async function launchToolWithIntegration(
  integration: ToolIntegration,
  spec: ToolLaunchSpec
): Promise<number> {
  const launch = createToolLaunchContext({
    spec,
    log: (line) => process.stderr.write(`${line}\n`),
    prepareForPassthrough: () => {},
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => {}
  });
  try {
    return await integration.launch(launch.context);
  } finally {
    await launch.dispose();
  }
}

export async function launchTool(input: {
  tool: string;
  config: RouterConfig;
  gatewayUrl?: string;
  model?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  host?: string;
  port?: number;
  ide?: boolean;
}): Promise<number> {
  const integration = routekitToolRegistry.get(input.tool);
  if (integration === undefined) throw new Error(`unknown tool: ${input.tool}`);
  if (integration.binary !== undefined && !commandOnPath(integration.binary)) {
    throw new Error(
      `routekit preflight failed: "${integration.binary}" was not found on PATH — ` +
        (integration.installHint ?? `install ${integration.binary}`)
    );
  }
  const running =
    input.gatewayUrl === undefined
      ? await startRouter({
          config: input.config,
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
          portless: false,
          register: false
        })
      : undefined;
  const gatewayUrl = input.gatewayUrl ?? running!.url;
  try {
    const catalog = await fetchLiveCatalog(gatewayUrl, {
      ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
      ...(input.config.defaultModel !== undefined
        ? { defaultModel: input.config.defaultModel }
        : {})
    });
    return await launchToolWithIntegration(
      integration,
      buildToolLaunchSpec({
        config: input.config,
        catalog: catalog.models,
        gatewayUrl,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
        ...(input.ide !== undefined ? { ide: input.ide } : {})
      })
    );
  } finally {
    await running?.close();
  }
}
