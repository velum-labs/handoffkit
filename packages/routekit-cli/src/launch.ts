import { toolRegistry as routekitToolRegistry } from "@routekit/tool-registry";
import type {
  ToolIntegration,
  ToolLaunchContext,
  ToolLaunchSpec,
  ToolModel,
  ToolModelFeatureStatus
} from "@routekit/tools";
import type { ModelEndpointConfig, RouterConfig } from "@routekit/gateway";
import { commandOnPath } from "@routekit/runtime";

import { startRouter } from "./serve.js";

export { routekitToolRegistry };

function featureStatus(
  status: ModelEndpointConfig["capabilities"] extends infer Capabilities
    ? Capabilities extends Record<string, infer Value>
      ? Value | undefined
      : never
    : never
): ToolModelFeatureStatus {
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
    default: {
      const unreachable: never = status;
      throw new Error(`unsupported endpoint capability: ${String(unreachable)}`);
    }
  }
}

function configuredModels(config: RouterConfig): ToolModel[] {
  const byId = new Map<string, ToolModel>();
  for (const endpoint of config.endpoints) {
    if (byId.has(endpoint.endpointId)) continue;
    byId.set(endpoint.endpointId, {
      id: endpoint.endpointId,
      label: endpoint.endpointId,
      features: {
        streaming: featureStatus(endpoint.capabilities?.streaming),
        tools: featureStatus(endpoint.capabilities?.tools),
        images: featureStatus(endpoint.capabilities?.images),
        reasoning_controls: featureStatus(endpoint.capabilities?.reasoning_controls)
      }
    });
  }
  return [...byId.values()];
}

export function buildToolLaunchSpec(input: {
  config: RouterConfig;
  gatewayUrl: string;
  model?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
  ide?: boolean;
}): ToolLaunchSpec {
  const models = configuredModels(input.config);
  const requested = input.model;
  const defaultModel =
    requested ?? input.config.defaultEndpointId ?? input.config.endpoints[0]!.endpointId;
  if (!models.some((model) => model.id === defaultModel)) {
    models.push({ id: defaultModel, label: defaultModel });
  }
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
  const disposers: Array<() => void | Promise<void>> = [];
  const context: ToolLaunchContext = {
    spec,
    log: (line) => process.stderr.write(`${line}\n`),
    prepareForPassthrough: () => {},
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => {},
    registerDisposer: (dispose) => disposers.push(dispose)
  };
  try {
    return await integration.launch(context);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
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
    return await launchToolWithIntegration(
      integration,
      buildToolLaunchSpec({
        config: input.config,
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
