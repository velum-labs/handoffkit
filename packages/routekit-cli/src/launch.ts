import { toolRegistry as routekitToolRegistry } from "@routekit/tool-registry";
import { resolveModelId } from "@routekit/config";
import { createToolLaunchContext } from "@routekit/tools";
import { resolveReasoningEffort } from "@routekit/contracts";
import type {
  ToolIntegration,
  ToolLaunchSpec,
  ToolModel,
  ToolModelFeatureStatus
} from "@routekit/tools";
import type { RouterConfig } from "@routekit/gateway";
import { commandOnPath } from "@routekit/runtime";

import { fetchLiveCatalog, type LiveModel } from "./catalog.js";

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
      },
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {})
    };
  });
}

export function buildToolLaunchSpec(input: {
  config: RouterConfig;
  catalog: readonly LiveModel[];
  gatewayUrl: string;
  model?: string;
  effort?: string;
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
  const requestedEffort = input.effort;
  const selectedModel = models.find((model) => model.id === defaultModel);
  const reasoning =
    requestedEffort === undefined || requestedEffort === "auto"
      ? undefined
      : selectedModel?.reasoning === undefined ||
          selectedModel.reasoning.status !== "supported"
        ? (() => {
            throw new Error(
              `model "${defaultModel}" has no discovered reasoning effort controls`
            );
          })()
        : (() => {
            const resolved = resolveReasoningEffort(
              selectedModel.reasoning,
              requestedEffort
            );
            if (resolved === undefined) {
              throw new Error(
                `reasoning effort "${requestedEffort}" is not supported by model "${defaultModel}"`
              );
            }
            return { mode: "effort" as const, effort: resolved };
          })();
  return {
    gatewayUrl: input.gatewayUrl,
    defaultModel,
    models,
    args: input.args ?? [],
    ...(reasoning !== undefined ? { reasoning } : {}),
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
  config?: RouterConfig;
  gatewayUrl: string;
  model?: string;
  effort?: string;
  args?: readonly string[];
  cwd?: string;
  authToken?: string;
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
  const catalog = await fetchLiveCatalog(input.gatewayUrl, {
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
    ...(input.config?.defaultModel !== undefined
      ? { defaultModel: input.config.defaultModel }
      : input.model !== undefined
        ? { defaultModel: input.model }
        : {})
  });
  const config =
    input.config ??
    ({
      providers: {},
      ...(input.model !== undefined ? { defaultModel: input.model } : {})
    } as RouterConfig);
  return await launchToolWithIntegration(
    integration,
    buildToolLaunchSpec({
      config,
      catalog: catalog.models,
      gatewayUrl: input.gatewayUrl,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
      ...(input.ide !== undefined ? { ide: input.ide } : {})
    })
  );
}
