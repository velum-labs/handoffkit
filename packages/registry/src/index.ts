/**
 * Fusion-only identities and panel presets generated from
 * spec/registry/fusion.json.
 *
 * Product-neutral provider, subscription, catalog, capability, pricing, and
 * local model metadata lives in @velum-labs/routekit-registry.
 */
import { FUSION_REGISTRY } from "./generated/data.js";

export { FUSION_REGISTRY };

export const FUSION_PANEL_MODEL: string = FUSION_REGISTRY.fusion.fusedModelLabel;
export const DEFAULT_ENSEMBLE_NAME = "default";
export const FUSION_MODEL_ID_PREFIX = "fusion-";

export function fusionModelId(ensemble: string): string {
  return ensemble === DEFAULT_ENSEMBLE_NAME
    ? FUSION_PANEL_MODEL
    : `${FUSION_MODEL_ID_PREFIX}${ensemble}`;
}

export const CURSOR_BRIDGE_MODEL_NAME: string = FUSION_REGISTRY.fusion.bridgeModelName;
export const LOCAL_MODEL_LABEL: string = FUSION_REGISTRY.fusion.localModelLabel;
export const FUSION_MODEL_ALIASES: readonly string[] = FUSION_REGISTRY.fusion.aliases;
export const FUSION_DEFAULT_ALIAS: string = FUSION_REGISTRY.fusion.defaultAlias;
export const FUSION_PANEL_ALIAS: string = FUSION_REGISTRY.fusion.panelAlias;
export const FUSION_GATEWAY_DEFAULT_BASE_URL: string =
  FUSION_REGISTRY.fusion.gatewayDefaultBaseUrl;
export const FUSION_GATEWAY_API_KEY_ENV: string = FUSION_REGISTRY.fusion.gatewayApiKeyEnv;

export type CatalogPanelMember = { id: string; model: string; provider: string };

export type BenchmarkPanelPreset = {
  panelId: string;
  members: readonly CatalogPanelMember[];
  judgeId: string;
  synthesizerId: string;
  note?: string;
};

export const DEFAULT_CLOUD_PANEL_MEMBERS: readonly CatalogPanelMember[] =
  FUSION_REGISTRY.fusion.defaultCloudPanel;

export const BENCHMARK_PANEL_PRESETS: Readonly<Record<string, BenchmarkPanelPreset>> =
  FUSION_REGISTRY.fusion.benchmarkPanels as Readonly<Record<string, BenchmarkPanelPreset>>;
