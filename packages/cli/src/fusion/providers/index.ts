/**
 * Resolve routing provider specs from fusion config and panel entries.
 *
 * Explicit `routing.providers` entries win; panel models with matching ids fill
 * gaps so a committed panel can double as the provider table.
 */

import type { PanelModelSpec } from "../env.js";
import type { RoutingProviderSpec } from "@fusionkit/model-gateway";
import { ROUTING_PROVIDER_KINDS } from "@fusionkit/model-gateway";

const PANEL_TO_ROUTING: Record<string, RoutingProviderSpec["provider"]> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "openai-compatible": "openai-compatible"
};

/** Map a panel model spec to a routing provider when the provider kind is supported. */
export function panelSpecToRoutingProvider(spec: PanelModelSpec): RoutingProviderSpec | undefined {
  const provider = spec.provider;
  if (provider === undefined || provider === "mlx") return undefined;
  const kind = PANEL_TO_ROUTING[provider];
  if (kind === undefined || !(ROUTING_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  return {
    id: spec.id,
    provider: kind,
    ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.keyEnv !== undefined ? { keyEnv: spec.keyEnv } : {})
  };
}

/**
 * Merge explicit routing providers with panel-derived providers (explicit wins).
 */
export function mergeRoutingProviders(
  explicit: readonly RoutingProviderSpec[],
  panel: readonly PanelModelSpec[] | undefined
): RoutingProviderSpec[] {
  const byId = new Map<string, RoutingProviderSpec>();
  for (const spec of panel ?? []) {
    const derived = panelSpecToRoutingProvider(spec);
    if (derived !== undefined) byId.set(derived.id, derived);
  }
  for (const spec of explicit) byId.set(spec.id, spec);
  return [...byId.values()];
}
