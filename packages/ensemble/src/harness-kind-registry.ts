import type { HarnessAdapter } from "./harness.js";
import { normalizeFusionBackendUrl } from "./unified-url.js";
import type { ToolHarnessProvider, ToolHarnessResolveOptions, UnifiedHarnessE2EOptions, UnifiedHarnessKind } from "./unified-types.js";
export type { PanelTrust, ToolHarnessProvider, ToolHarnessResolveOptions, UnifiedHarnessKind } from "./unified-types.js";

let toolHarnessProvider: ToolHarnessProvider | undefined;

/**
 * Register the provider that resolves tool-backed harness kinds. The fusionkit
 * CLI wires this at startup from its tool registry.
 */
export function setToolHarnessProvider(provider: ToolHarnessProvider | undefined): void {
  toolHarnessProvider = provider;
}

export function requireToolHarnessProvider(kind: UnifiedHarnessKind): ToolHarnessProvider {
  if (toolHarnessProvider === undefined) {
    throw new Error(
      `no tool harness provider registered for harness kind "${kind}"; ` +
        "the fusionkit CLI wires this via setToolHarnessProvider (build the tool registry first)."
    );
  }
  return toolHarnessProvider;
}

export function resolveToolAdapter(
  kind: UnifiedHarnessKind,
  options: UnifiedHarnessE2EOptions
): HarnessAdapter {
  return requireToolHarnessProvider(kind).adapter(kind, {
    fusionBackendUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
    ...(options.fusionApiKey !== undefined ? { fusionApiKey: options.fusionApiKey } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.modelEndpoints !== undefined ? { modelEndpoints: options.modelEndpoints } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
    ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
    ...(options.panelTrust !== undefined ? { panelTrust: options.panelTrust } : {}),
    ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
    ...(options.fusedSubagents !== undefined ? { fusedSubagents: options.fusedSubagents } : {}),
    ...(options.resumeCursors !== undefined ? { resumeCursors: options.resumeCursors } : {})
  });
}
