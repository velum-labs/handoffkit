/**
 * Typed accessors over the generated registry data (spec/registry/*.json).
 *
 * This package is the Node-side single source of truth for provider metadata
 * (base URLs, API key env vars, key probes, discovery), subscription auth
 * metadata (Claude Code / Codex logins), the fusion model identity, the
 * cloud/local model catalogs, model-family capability quirks, and default
 * pricing. The Python workspace consumes the same data through
 * `fusionkit_core._generated.registry_data` — both are generated from the same
 * JSON by `scripts/generate-registry.mjs`, so the two stacks cannot drift.
 *
 * Zero runtime dependencies (node builtins only) so any package can depend on
 * it without cycles.
 */
import { REGISTRY } from "./generated/data.js";

export { REGISTRY };

// ---- providers --------------------------------------------------------------

export type ProviderAuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | "query-key";

export type ProviderKeyProbe = {
  path: string;
  auth: ProviderAuthStyle;
  extraHeaders?: Record<string, string>;
  invalidStatuses: readonly number[];
};

export type ProviderDiscovery = {
  path: string;
  auth: ProviderAuthStyle;
  extraHeaders?: Record<string, string>;
  responseShape: "openai" | "anthropic" | "google";
  /** Default source for human-facing pickers when live discovery is too noisy. */
  pickerDefaultSource?: "live" | "curated";
};

export type ProviderInfo = {
  baseUrl?: string;
  keyEnv?: string;
  /** Env var carrying a bearer/auth token alternative to the API key (anthropic). */
  authTokenEnv?: string;
  /** Env var overriding the provider base URL. */
  baseUrlEnv?: string;
  /** Ordered env var names that may carry the provider credential (codex). */
  credentialEnvNames?: readonly string[];
  apiCompatibility?: string;
  attributionHeaders?: Record<string, string>;
  keyProbe?: ProviderKeyProbe;
  discovery?: ProviderDiscovery;
};

/** All registered providers, keyed by canonical provider id. */
export const PROVIDERS: Readonly<Record<string, ProviderInfo>> = REGISTRY.providers as Readonly<
  Record<string, ProviderInfo>
>;

/** Default base URL for a provider, or undefined for local providers (mlx). */
export function providerDefaultBaseUrl(provider: string): string | undefined {
  return PROVIDERS[provider]?.baseUrl;
}

/** Default env var holding the API key for a provider, or undefined. */
export function defaultKeyEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.keyEnv;
}

/** Cheap key-validation probe metadata for a provider, or undefined. */
export function providerKeyProbe(provider: string): ProviderKeyProbe | undefined {
  return PROVIDERS[provider]?.keyProbe;
}

/** Live model-discovery capability for a provider, or undefined. */
export function providerDiscovery(provider: string): ProviderDiscovery | undefined {
  return PROVIDERS[provider]?.discovery;
}

// ---- subscriptions -----------------------------------------------------------

export type SubscriptionMode = "claude-code" | "codex";

export type SubscriptionInfo = {
  provider: string;
  /** Credential store location with a leading `~/` (expand against $HOME). */
  credentialsPath: string;
  keychainService?: string;
  configPath?: string;
  modelsCachePath?: string;
  authFileName?: string;
  defaultModel: string;
  oauthBetaHeader?: string;
  spoofSystemPrompt?: string;
  defaultInstructions?: string;
  defaultHeaders?: Record<string, string>;
  requestDefaults?: { stream?: boolean; store?: boolean; omitSampling?: boolean };
  /** Ordered env override chains for pointing the harness at another endpoint (codex). */
  overrideEnv?: Record<string, readonly string[]>;
};

export const SUBSCRIPTIONS: Readonly<Record<SubscriptionMode, SubscriptionInfo>> =
  REGISTRY.subscriptions as Readonly<Record<SubscriptionMode, SubscriptionInfo>>;

/** Subscription metadata for an auth mode. */
export function subscriptionInfo(mode: SubscriptionMode): SubscriptionInfo {
  return SUBSCRIPTIONS[mode];
}

/** The provider a subscription auth mode speaks (claude-code -> anthropic, codex -> codex). */
export function providerForAuthMode(mode: SubscriptionMode): string {
  return SUBSCRIPTIONS[mode].provider;
}

// ---- fusion model identity ----------------------------------------------------

/** The model label the fused panel is fronted under (gateway + tool pickers). */
export const FUSION_PANEL_MODEL: string = REGISTRY.fusion.fusedModelLabel;

/** The name of the implicit/default ensemble (advertised as {@link FUSION_PANEL_MODEL}). */
export const DEFAULT_ENSEMBLE_NAME = "default";

/** The id prefix every non-default ensemble's fused model is advertised under. */
export const FUSION_MODEL_ID_PREFIX = "fusion-";

/**
 * The advertised model id for a named ensemble: `fusion-<name>`, except the
 * default ensemble which keeps the canonical {@link FUSION_PANEL_MODEL} id
 * (`fusion-panel`) for full back-compat with single-ensemble configs.
 */
export function fusionModelId(ensemble: string): string {
  return ensemble === DEFAULT_ENSEMBLE_NAME
    ? FUSION_PANEL_MODEL
    : `${FUSION_MODEL_ID_PREFIX}${ensemble}`;
}

/** The model name the Cursor bridge exposes to cursor-agent. */
export const CURSOR_BRIDGE_MODEL_NAME: string = REGISTRY.fusion.bridgeModelName;

/** Provider/model label a tool advertises for the gateway-backed local model. */
export const LOCAL_MODEL_LABEL: string = REGISTRY.fusion.localModelLabel;

/** Reserved fusion aliases the Python server's chat front door understands. */
export const FUSION_MODEL_ALIASES: readonly string[] = REGISTRY.fusion.aliases;

/** The Python server's default (router) fusion alias. */
export const FUSION_DEFAULT_ALIAS: string = REGISTRY.fusion.defaultAlias;

/** The panel-mode fusion alias external benchmark runners target. */
export const FUSION_PANEL_ALIAS: string = REGISTRY.fusion.panelAlias;

/** Default local FusionKit gateway base URL used by benchmark runners. */
export const FUSION_GATEWAY_DEFAULT_BASE_URL: string = REGISTRY.fusion.gatewayDefaultBaseUrl;

/** Env var external runners can read for a FusionKit gateway API key placeholder. */
export const FUSION_GATEWAY_API_KEY_ENV: string = REGISTRY.fusion.gatewayApiKeyEnv;

// ---- model catalog -------------------------------------------------------------

export type CatalogPanelMember = { id: string; model: string; provider: string };

export type BenchmarkPanelPreset = {
  panelId: string;
  members: readonly CatalogPanelMember[];
  judgeId: string;
  synthesizerId: string;
  note?: string;
};

/** The default cloud panel trio (OpenAI + Anthropic + Google). */
export const DEFAULT_CLOUD_PANEL_MEMBERS: readonly CatalogPanelMember[] =
  REGISTRY.modelCatalog.defaultCloudPanel;

/** Named benchmark/live-smoke panel presets shared by CLI scripts and Python evals. */
export const BENCHMARK_PANEL_PRESETS: Readonly<Record<string, BenchmarkPanelPreset>> = REGISTRY
  .modelCatalog.benchmarkPanels as Readonly<Record<string, BenchmarkPanelPreset>>;

/** The default narration-writer model for a bare `--reasoning-model` flag. */
export const DEFAULT_REASONING_MODEL: string = REGISTRY.modelCatalog.defaultReasoningModel;

/** The default model for an auth choice, or undefined for unknown choices. */
export function catalogDefaultModel(choice: string): string | undefined {
  return (REGISTRY.modelCatalog.defaultModelByAuthChoice as Record<string, string>)[choice];
}

/** Curated fallback model list for an auth choice (may be empty). */
export function curatedModels(choice: string): readonly string[] {
  return (REGISTRY.modelCatalog.curated as Record<string, readonly string[]>)[choice] ?? [];
}

/** Default smoke-test model for a tool id, or undefined. */
export function smokeModelForTool(tool: string): string | undefined {
  return (REGISTRY.modelCatalog.smokeModels as Record<string, string>)[tool];
}

// ---- model capabilities ---------------------------------------------------------

type MatchFamily = { id: string; requires: readonly string[]; anyOf?: readonly string[] };

function familyMatches(family: MatchFamily, loweredModel: string): boolean {
  if (!family.requires.every((needle) => loweredModel.includes(needle))) return false;
  if (family.anyOf !== undefined && !family.anyOf.some((needle) => loweredModel.includes(needle))) {
    return false;
  }
  return true;
}

type SamplingFamily = MatchFamily & { overrides: Readonly<Record<string, number>> };
type ChatTemplateFamily = MatchFamily & { chatTemplateKwargs: Readonly<Record<string, boolean>> };

/**
 * Per-model sampling overrides (first matching family wins), e.g. qwen-family
 * models want temperature 0.55 / top_p 1.0. Empty when no family matches.
 */
export function samplingOverridesForModel(model: string): Readonly<Record<string, number>> {
  const lowered = model.toLowerCase();
  const families = REGISTRY.modelCapabilities.samplingFamilies as readonly SamplingFamily[];
  for (const family of families) {
    if (familyMatches(family, lowered)) return family.overrides;
  }
  return {};
}

/**
 * Chat-template kwargs the local MLX gateway should default for a model family
 * (e.g. Qwen `enable_thinking`), or undefined when no family matches.
 */
export function chatTemplateKwargsForModel(
  model: string
): Readonly<Record<string, boolean>> | undefined {
  const lowered = model.toLowerCase();
  const families = REGISTRY.modelCapabilities.chatTemplateFamilies as readonly ChatTemplateFamily[];
  for (const family of families) {
    if (familyMatches(family, lowered)) return family.chatTemplateKwargs;
  }
  return undefined;
}

// ---- pricing ---------------------------------------------------------------------

export type RegistryModelPricing = { inputPer1mTokens: number; outputPer1mTokens: number };

/**
 * Default per-model list prices (USD / 1M tokens), manual overrides merged over
 * the generated table. Matched by longest prefix by consumers.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, RegistryModelPricing>> = {
  ...(REGISTRY.pricing.models as Record<string, RegistryModelPricing>),
  ...(REGISTRY.pricing.manualOverrides as Record<string, RegistryModelPricing>)
};

// ---- local catalog ----------------------------------------------------------------

export type LocalModelRole = "general" | "coder";

export type LocalCatalogModel = {
  repo: string;
  label: string;
  params: string;
  quant: string;
  sizeGB: number;
  minRamGB: number;
  blurb: string;
  role: LocalModelRole;
};

/** The curated local MLX catalog, ordered small -> large. */
export const LOCAL_CATALOG_ENTRIES: readonly LocalCatalogModel[] = REGISTRY.localCatalog
  .entries as readonly LocalCatalogModel[];

export type PreferredLocalModel = { id: string; repo: string };

/** Repos `defaultTrioFor` prefers first, in order, with their panel member ids. */
export const PREFERRED_LOCAL_MODELS: readonly PreferredLocalModel[] =
  REGISTRY.localCatalog.preferred;

/** The standalone model-gateway MLX fallback model. */
export const GATEWAY_DEFAULT_MLX_MODEL: string = REGISTRY.localCatalog.gatewayDefaultModel;

/** Throwaway model id used to construct model-agnostic MLX envs. */
export const LOCAL_PROBE_MODEL: string = REGISTRY.localCatalog.probeModel;
