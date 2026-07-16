import { toolRegistry as routekitToolRegistry } from "@routekit/tool-registry";
import {
  configuredEndpointIds,
  resolveEndpointId
} from "@routekit/config";
import { createToolLaunchContext } from "@routekit/tools";
import type {
  ToolIntegration,
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
  return configuredEndpointIds(config).map((endpointId) => {
    const endpoint = config.endpoints.find((entry) => entry.endpointId === endpointId)!;
    return {
      id: endpoint.endpointId,
      label: endpoint.endpointId,
      features: {
        streaming: featureStatus(endpoint.capabilities?.streaming),
        tools: featureStatus(endpoint.capabilities?.tools),
        images: featureStatus(endpoint.capabilities?.images),
        reasoning_controls: featureStatus(endpoint.capabilities?.reasoning_controls)
      }
    };
  });
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
  const defaultModel = resolveEndpointId(input.config, input.model);
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
