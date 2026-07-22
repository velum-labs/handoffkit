import type { HarnessKind } from "@routekit/harness-core";

import type {
  ToolCapabilityGrade,
  ToolIntegration,
  ToolModel,
  ToolModelFeature
} from "./types.js";

export type ToolRegistry = {
  /** Resolve a tool by id or alias. */
  get(idOrAlias: string): ToolIntegration | undefined;
  /** All registered tools, in registration order. */
  list(): ToolIntegration[];
  /** Resolve the one canonical driver by its harness kind. */
  driverForKind(kind: HarnessKind): ToolIntegration | undefined;
  /** All canonical drivers in registration order. */
  drivers(): ToolIntegration[];
};

export function createToolRegistry(integrations: readonly ToolIntegration[]): ToolRegistry {
  const byKey = new Map<string, ToolIntegration>();
  const byKind = new Map<HarnessKind, ToolIntegration>();
  for (const integration of integrations) {
    if (byKey.has(integration.id)) {
      throw new Error(`tool integration already registered for id "${integration.id}"`);
    }
    byKey.set(integration.id, integration);
    for (const alias of integration.aliases ?? []) {
      if (byKey.has(alias)) throw new Error(`tool integration alias already registered: "${alias}"`);
      byKey.set(alias, integration);
    }
    const kind = integration.driver.kind;
    if (byKind.has(kind)) throw new Error(`tool driver already registered for kind "${kind}"`);
    byKind.set(kind, integration);
  }
  return {
    get: (idOrAlias) => byKey.get(idOrAlias),
    list: () => [...integrations],
    driverForKind: (kind) => byKind.get(kind),
    drivers: () => [...integrations]
  };
}

export type ToolCapabilityCell = {
  modelId: string;
  toolId: string;
  feature: ToolModelFeature;
  grade: ToolCapabilityGrade;
};

function gradeFor(
  integration: ToolIntegration,
  model: ToolModel,
  feature: ToolModelFeature
): ToolCapabilityGrade {
  const modelStatus = model.features?.[feature] ?? "unknown";
  const toolStatus = integration.capabilities[feature];
  if (modelStatus === "unsupported" || toolStatus === "unsupported") return "unsupported";
  if (modelStatus === "full" && toolStatus === "full") return "full";
  return "degraded";
}

/** Evaluate opaque model metadata against every registered harness. */
export function createToolCapabilityMatrix(
  registry: ToolRegistry,
  models: readonly ToolModel[]
): ToolCapabilityCell[] {
  const features: readonly ToolModelFeature[] = [
    "streaming",
    "tools",
    "images",
    "reasoning_controls"
  ];
  return models.flatMap((model) =>
    registry.list().flatMap((integration) =>
      features.map((feature) => ({
        modelId: model.id,
        toolId: integration.id,
        feature,
        grade: gradeFor(integration, model, feature)
      }))
    )
  );
}
