import type { HarnessKind } from "@routekit/harness-core";

import { createDriverHarness } from "./driver-adapter.js";
import type { HarnessAdapter } from "./harness.js";
import type {
  ToolDriverRegistry,
  ToolHarnessResolveOptions,
  UnifiedHarnessE2EOptions,
  UnifiedHarnessKind
} from "./unified-types.js";
import { normalizeFusionBackendUrl } from "./unified-url.js";

let toolDriverRegistry: ToolDriverRegistry | undefined;

export function setToolDriverRegistry(registry: ToolDriverRegistry | undefined): void {
  toolDriverRegistry = registry;
}

export function harnessKindForUnified(kind: UnifiedHarnessKind): HarnessKind | undefined {
  switch (kind) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude_code";
    case "cursor-acp":
    case "cursor-desktop":
      return "cursor";
    case "opencode":
      return "opencode";
    case "mock":
    case "command":
    case "agent":
      return undefined;
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function requireDriver(kind: UnifiedHarnessKind) {
  const harnessKind = harnessKindForUnified(kind);
  if (harnessKind === undefined) {
    throw new Error(`"${kind}" is not a tool-backed harness`);
  }
  const integration = toolDriverRegistry?.driverForKind(harnessKind);
  if (integration === undefined) {
    throw new Error(`no canonical driver registered for harness kind "${harnessKind}"`);
  }
  return integration.driver;
}

export function resolveToolAdapter(
  kind: UnifiedHarnessKind,
  options: UnifiedHarnessE2EOptions
): HarnessAdapter {
  return resolveToolDriverAdapter(kind, {
    fusionBackendUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
    ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {})
  });
}

export function resolveToolDriverAdapter(
  kind: UnifiedHarnessKind,
  options: ToolHarnessResolveOptions
): HarnessAdapter {
  const registration = requireDriver(kind);
  return createDriverHarness({
    driver: registration.driver,
    gatewayUrl: options.fusionBackendUrl,
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {}),
    configForModel: (route) =>
      registration.configForRoute({
        gatewayUrl: route.endpointUrl,
        model: route.model,
        ...(options.fusionApiKey !== undefined ? { authToken: options.fusionApiKey } : {})
      })
  });
}
