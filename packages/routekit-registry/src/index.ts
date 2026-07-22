/**
 * Typed accessors over RouteKit's generated neutral registry data.
 *
 * Provider/auth metadata, model catalogs, capabilities, pricing, and local
 * model data are generated from spec/registry. Product-specific identities and
 * panel presets are deliberately excluded.
 */
import { REGISTRY } from "./generated/data.js";

export { REGISTRY };

export type ProviderAuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

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
  responseShape: ProviderDiscoveryResponseShape;
  pickerDefaultSource?: "live" | "curated";
};

export type ProviderDiscoveryResponseShape = "openai" | "anthropic" | "google" | "codex";

export type ProviderWireProtocol = "openai" | "anthropic" | "google" | "codex";

export type ProviderWire = {
  protocol: ProviderWireProtocol;
  basePath: string;
};

export type ProviderInfo = {
  baseUrl?: string;
  keyEnv?: string;
  authTokenEnv?: string;
  baseUrlEnv?: string;
  credentialEnvNames?: readonly string[];
  apiCompatibility?: string;
  attributionHeaders?: Record<string, string>;
  keyProbe?: ProviderKeyProbe;
  discovery?: ProviderDiscovery;
  wire?: ProviderWire;
};

export const PROVIDERS: Readonly<Record<string, ProviderInfo>> = REGISTRY.providers as Readonly<
  Record<string, ProviderInfo>
>;

export function providerDefaultBaseUrl(provider: string): string | undefined {
  return PROVIDERS[provider]?.baseUrl;
}

export function defaultKeyEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.keyEnv;
}

export function providerKeyProbe(provider: string): ProviderKeyProbe | undefined {
  return PROVIDERS[provider]?.keyProbe;
}

export function providerDiscovery(provider: string): ProviderDiscovery | undefined {
  return PROVIDERS[provider]?.discovery;
}

export type SubscriptionMode = "claude-code" | "codex";

export type SubscriptionOAuthInfo = {
  tokenEndpoint: string;
  clientId: string;
  usageEndpoint: string;
  profileEndpoint?: string;
  usagePathFallback?: string;
};

export type SubscriptionRateLimitInfo = {
  headerPrefix: string;
  activeLimitHeader?: string;
  retryAfterHeader: string;
};

export type SubscriptionAdminInfo = {
  keyEnv: string;
  usageEndpoint: string;
  costEndpoint: string;
};

export type SubscriptionInfo = {
  provider: string;
  credentialsPath: string;
  accountsDirectory: string;
  keychainService?: string;
  configPath?: string;
  modelsCachePath?: string;
  authFileName?: string;
  defaultModel: string;
  wire: ProviderWire;
  discovery: {
    path: string;
    responseShape: ProviderDiscoveryResponseShape;
    cacheFallback?: boolean;
    extraHeaders?: Record<string, string>;
  };
  oauthBetaHeader?: string;
  spoofSystemPrompt?: string;
  defaultInstructions?: string;
  defaultHeaders?: Record<string, string>;
  requestDefaults?: { stream?: boolean; store?: boolean; omitSampling?: boolean };
  oauth: SubscriptionOAuthInfo;
  rateLimit: SubscriptionRateLimitInfo;
  admin: SubscriptionAdminInfo;
  overrideEnv?: Record<string, readonly string[]>;
};

export const SUBSCRIPTIONS: Readonly<Record<SubscriptionMode, SubscriptionInfo>> =
  REGISTRY.subscriptions as Readonly<Record<SubscriptionMode, SubscriptionInfo>>;

export function subscriptionInfo(mode: SubscriptionMode): SubscriptionInfo {
  return SUBSCRIPTIONS[mode];
}

export function providerForAuthMode(mode: SubscriptionMode): string {
  return SUBSCRIPTIONS[mode].provider;
}

export type AccountConnector = "native" | "cliproxy";

export type AccountConnectorInfo = {
  connector: AccountConnector;
  /** CLIProxyAPI login flag (cliproxy-backed kinds only). */
  cliproxyLoginFlag?: string;
  /** CLIProxyAPI auth-store `type` values that classify as this kind. */
  cliproxyAuthTypes?: readonly string[];
  /** ToS restriction: reverse-engineered upstream, personal/local use only. */
  localOnly?: boolean;
  aliases?: readonly string[];
};

export const ACCOUNT_CONNECTORS: Readonly<Record<string, AccountConnectorInfo>> =
  REGISTRY.connectors as Readonly<Record<string, AccountConnectorInfo>>;

/** Canonical account kinds known to the neutral registry (not a support contract). */
export function accountKinds(): readonly string[] {
  return Object.keys(ACCOUNT_CONNECTORS);
}

/** Canonical registry kinds plus their aliases (not necessarily public CLI choices). */
export function accountKindChoices(): readonly string[] {
  return [
    ...accountKinds(),
    ...Object.values(ACCOUNT_CONNECTORS).flatMap((info) => info.aliases ?? [])
  ];
}

/**
 * Resolve a user-supplied account kind (canonical name or alias) to its
 * canonical kind and connector metadata.
 */
export function resolveAccountConnector(
  value: string
): { kind: string; info: AccountConnectorInfo } | undefined {
  const direct = ACCOUNT_CONNECTORS[value];
  if (direct !== undefined) return { kind: value, info: direct };
  for (const [kind, info] of Object.entries(ACCOUNT_CONNECTORS)) {
    if (info.aliases?.includes(value) === true) return { kind, info };
  }
  return undefined;
}

/** Classify a CLIProxyAPI auth-store `type` value back to a canonical kind. */
export function accountKindForCliproxyAuthType(type: string): string | undefined {
  for (const [kind, info] of Object.entries(ACCOUNT_CONNECTORS)) {
    if (info.cliproxyAuthTypes?.includes(type) === true) return kind;
  }
  return undefined;
}

export const DEFAULT_REASONING_MODEL: string = REGISTRY.modelCatalog.defaultReasoningModel;

export function catalogDefaultModel(choice: string): string | undefined {
  return (REGISTRY.modelCatalog.defaultModelByAuthChoice as Record<string, string>)[choice];
}

export function curatedModels(choice: string): readonly string[] {
  return (REGISTRY.modelCatalog.curated as Record<string, readonly string[]>)[choice] ?? [];
}

export function smokeModelForTool(tool: string): string | undefined {
  return (REGISTRY.modelCatalog.smokeModels as Record<string, string>)[tool];
}

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

export function samplingOverridesForModel(model: string): Readonly<Record<string, number>> {
  const lowered = model.toLowerCase();
  const families = REGISTRY.modelCapabilities.samplingFamilies as readonly SamplingFamily[];
  for (const family of families) {
    if (familyMatches(family, lowered)) return family.overrides;
  }
  return {};
}

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

export type RegistryModelPricing = { inputPer1mTokens: number; outputPer1mTokens: number };

export const PRICING_ALIASES: Readonly<Record<string, string>> = (
  REGISTRY.pricing.aliases ?? {}
) as Record<string, string>;

export const DEFAULT_MODEL_PRICING: Readonly<Record<string, RegistryModelPricing>> = {
  ...(REGISTRY.pricing.models as Record<string, RegistryModelPricing>),
  ...(REGISTRY.pricing.manualOverrides as Record<string, RegistryModelPricing>)
};

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

export const LOCAL_CATALOG_ENTRIES: readonly LocalCatalogModel[] = REGISTRY.localCatalog
  .entries as readonly LocalCatalogModel[];

export type PreferredLocalModel = { id: string; repo: string };

export const PREFERRED_LOCAL_MODELS: readonly PreferredLocalModel[] =
  REGISTRY.localCatalog.preferred;

export const GATEWAY_DEFAULT_MLX_MODEL: string = REGISTRY.localCatalog.gatewayDefaultModel;
export const LOCAL_PROBE_MODEL: string = REGISTRY.localCatalog.probeModel;
