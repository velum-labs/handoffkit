import type {
  HarnessAdapter,
  ToolHarnessResolveOptions,
  UnifiedHarnessKind
} from "@fusionkit/ensemble";
import type { ModelFusionSideEffects } from "@fusionkit/protocol";

import type { ToolDashboardMetadata, ToolIntegration } from "./types.js";

export type ToolRegistry = {
  /** Resolve a tool by id or alias. */
  get(idOrAlias: string): ToolIntegration | undefined;
  /** All registered tools, in registration order. */
  list(): ToolIntegration[];
  /** Tools that can be launched behind the fusion panel. */
  launchableFusion(): ToolIntegration[];
  /** Tools that can be launched against a single local model. */
  launchableLocal(): ToolIntegration[];
  /** Build the ensemble harness adapter for a unified harness kind. */
  harnessForKind(kind: UnifiedHarnessKind, options: ToolHarnessResolveOptions): HarnessAdapter;
  /** Policy side-effects for a tool-backed harness kind. */
  sideEffectsForKind(kind: UnifiedHarnessKind): ModelFusionSideEffects;
  /** Judge response-shape hint for a tool-backed harness kind. */
  responseShapeForKind(kind: UnifiedHarnessKind): string;
  /** All unified harness kinds answered by a registered tool. */
  harnessKinds(): UnifiedHarnessKind[];
  /** Dashboard metadata for tools that provide it, in registration order. */
  dashboardTools(): ToolDashboardMetadata[];
};

/**
 * Assemble a tool registry from a fixed list of integrations. The CLI is the
 * single place that knows every tool package, so it builds the registry here and
 * wires it into both the launchers and (via `setToolAdapterResolver`) the
 * ensemble harness gateway. Adding a tool is one new package plus one entry in
 * the list the CLI passes here.
 */
export function createToolRegistry(integrations: readonly ToolIntegration[]): ToolRegistry {
  const byKey = new Map<string, ToolIntegration>();
  for (const integration of integrations) {
    byKey.set(integration.id, integration);
    for (const alias of integration.aliases ?? []) {
      byKey.set(alias, integration);
    }
  }
  const harnessIndex = new Map<UnifiedHarnessKind, ToolIntegration>();
  for (const integration of integrations) {
    for (const kind of integration.harnessKinds) {
      harnessIndex.set(kind, integration);
    }
  }
  const toolForKind = (kind: UnifiedHarnessKind): ToolIntegration => {
    const integration = harnessIndex.get(kind);
    if (integration === undefined) {
      throw new Error(`no tool integration provides a harness for kind "${kind}"`);
    }
    return integration;
  };
  return {
    get: (idOrAlias) => byKey.get(idOrAlias),
    list: () => [...integrations],
    launchableFusion: () => integrations.filter((tool) => tool.modes.includes("fusion")),
    launchableLocal: () => integrations.filter((tool) => tool.modes.includes("local")),
    harnessForKind: (kind, options) => {
      const integration = toolForKind(kind);
      if (integration.createHarness === undefined) {
        throw new Error(`tool "${integration.id}" has no harness factory for kind "${kind}"`);
      }
      return integration.createHarness(kind, options);
    },
    sideEffectsForKind: (kind) => {
      const harness = toolForKind(kind).harness;
      if (harness === undefined) {
        throw new Error(`tool for kind "${kind}" has no harness metadata`);
      }
      return harness.sideEffects;
    },
    responseShapeForKind: (kind) => {
      const harness = toolForKind(kind).harness;
      if (harness === undefined) {
        throw new Error(`tool for kind "${kind}" has no harness metadata`);
      }
      return harness.responseShape;
    },
    harnessKinds: () => integrations.flatMap((tool) => [...tool.harnessKinds]),
    dashboardTools: () =>
      integrations
        .map((tool) => tool.dashboard)
        .filter((dashboard): dashboard is ToolDashboardMetadata => dashboard !== undefined)
  };
}
