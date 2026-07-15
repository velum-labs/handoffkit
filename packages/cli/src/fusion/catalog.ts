/**
 * Live provider model catalogs with a small on-disk cache — the data source
 * behind "pick a model" fuzzy pickers and dynamic shell completion. Pickers
 * open instantly on cached entries and refresh in the background
 * (stale-while-revalidate); completion reads the cache only, never the
 * network. A fetch failure degrades to the cache (or an empty list) —
 * catalog data is a convenience, never a hard requirement.
 *
 * Sources, per provider:
 * - With an API key: the provider's own listing endpoint (the ground truth of
 *   what THIS account can call), enriched with pricing/context metadata from
 *   models.dev.
 * - Without a key: models.dev (https://models.dev — an open-source,
 *   keyless model catalog), so pickers still show real model ids before any
 *   credential exists. OpenRouter's own listing is public and already carries
 *   pricing, so it stays native.
 * - mlx: the Hugging Face public listing of the `mlx-community` org (where
 *   virtually all usable MLX conversions live), most-downloaded first.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  curatedModels,
  defaultKeyEnv as registryDefaultKeyEnv,
  providerDefaultBaseUrl,
  providerDiscovery
} from "@routekit/registry";
import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey,
  cliproxyBaseUrl
} from "@routekit/accounts";
import { providerAuthHeaders } from "@routekit/gateway";

import { defaultKeyEnv } from "./env.js";
import type { PanelProvider } from "./env.js";
import { LOCAL_CATALOG_REPOS } from "./local-catalog.js";
import { listOpenAiCompatibleModels } from "./openai-models.js";
import { defaultModelForAuthChoice } from "./panel-auth.js";
import type { AuthChoice } from "./panel-auth.js";

export type CatalogModel = {
  /** The provider-native model id (what goes in `ID=PROVIDER:MODEL`). */
  id: string;
  /** A human display name when the provider offers one. */
  label?: string;
  /** A compact price note, e.g. "$0.55/M in · $2.19/M out". */
  pricing?: string;
  /** Context window length in tokens. */
  context?: number;
};

type CatalogFile = {
  version: 1;
  providers: Partial<Record<string, { fetchedAt: number; models: CatalogModel[] }>>;
};

/** Cloud providers whose model list can be fetched (openai-compatible has no fixed list). */
export const CATALOG_PROVIDERS: readonly PanelProvider[] = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "cliproxy"
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

/** The open-source keyless model catalog (used when no provider key is set). */
const MODELS_DEV_URL = "https://models.dev/api.json";

/** HF public listing of the mlx-community org, most-downloaded first. */
const MLX_COMMUNITY_URL =
  "https://huggingface.co/api/models?author=mlx-community&pipeline_tag=text-generation&sort=downloads&direction=-1&limit=200";

export function catalogCachePath(): string {
  return process.env.FUSIONKIT_CATALOG_PATH ?? join(homedir(), ".fusionkit", "catalog.json");
}

function readCatalogFile(): CatalogFile {
  try {
    const parsed = JSON.parse(readFileSync(catalogCachePath(), "utf8")) as CatalogFile;
    if (parsed.version === 1 && typeof parsed.providers === "object") return parsed;
  } catch {
    // missing or corrupt cache: start fresh
  }
  return { version: 1, providers: {} };
}

function writeCatalogFile(file: CatalogFile): void {
  try {
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  } catch {
    // cache writes are best-effort
  }
}

/** True when `provider`'s own (account-scoped) listing can be fetched. */
function providerListingAvailable(provider: PanelProvider): boolean {
  if (provider === "openrouter") return true; // public listing
  const keyEnv = defaultKeyEnv(provider);
  return keyEnv !== undefined && (process.env[keyEnv] ?? "").length > 0;
}

/**
 * True when `provider`'s catalog can be fetched with the current env. Cloud
 * providers are always fetchable (models.dev is keyless); mlx lists the
 * public mlx-community org; only ad-hoc openai-compatible endpoints have no
 * listable catalog.
 */
export function catalogProviderAvailable(provider: PanelProvider): boolean {
  return CATALOG_PROVIDERS.includes(provider) || provider === "mlx";
}

/** The cached models for `provider` (possibly stale), or an empty list. */
export function cachedCatalog(provider: PanelProvider): CatalogModel[] {
  return readCatalogFile().providers[provider]?.models ?? [];
}

/** True when the cache for `provider` is missing or older than the TTL. */
export function catalogStale(provider: PanelProvider): boolean {
  const entry = readCatalogFile().providers[provider];
  return entry === undefined || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function formatPerMillion(perToken: string | number | undefined): string | undefined {
  const value = typeof perToken === "string" ? Number.parseFloat(perToken) : perToken;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const perMillion = value * 1_000_000;
  const text = perMillion >= 10 ? perMillion.toFixed(0) : perMillion.toFixed(2);
  return `$${text}/M`;
}

type JsonRecord = Record<string, unknown>;

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<JsonRecord> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as JsonRecord;
}

// The models.dev payload covers every provider in one document; memoize it per
// process so refreshing several providers costs one fetch. Injected fetchers
// (tests) bypass the memo so they can never poison real lookups.
let modelsDevBody: Promise<JsonRecord> | undefined;

function fetchModelsDev(fetchImpl: typeof fetch = fetch): Promise<JsonRecord> {
  if (fetchImpl !== fetch) return fetchJson(MODELS_DEV_URL, {}, fetchImpl);
  modelsDevBody ??= fetchJson(MODELS_DEV_URL, {}).catch((error: unknown) => {
    modelsDevBody = undefined; // allow a later retry
    throw error;
  });
  return modelsDevBody;
}

/** Format a models.dev cost entry (already $/1M tokens) as a pricing note. */
function modelsDevPricing(cost: JsonRecord | undefined): string | undefined {
  const per = (value: unknown): string | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return `$${value >= 10 ? value.toFixed(0) : String(value)}/M`;
  };
  const input = per(cost?.input);
  const output = per(cost?.output);
  if (input !== undefined && output !== undefined) return `${input} in · ${output} out`;
  return input ?? output;
}

/** The models.dev catalog for one provider (its ids match ours directly). */
async function fetchModelsDevCatalog(
  provider: PanelProvider,
  fetchImpl: typeof fetch = fetch
): Promise<CatalogModel[]> {
  const body = await fetchModelsDev(fetchImpl);
  const entry = body[provider] as JsonRecord | undefined;
  const models = (entry?.models ?? {}) as Record<string, JsonRecord>;
  return Object.values(models)
    .map((model) => {
      const pricing = modelsDevPricing(model.cost as JsonRecord | undefined);
      const context = (model.limit as JsonRecord | undefined)?.context;
      return {
        id: String(model.id ?? ""),
        ...(typeof model.name === "string" && model.name !== model.id ? { label: model.name } : {}),
        ...(pricing !== undefined ? { pricing } : {}),
        ...(typeof context === "number" ? { context } : {})
      };
    })
    .filter((model) => model.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Merge models.dev pricing/context/labels into a provider-fetched list. */
async function enrichWithModelsDev(
  provider: PanelProvider,
  models: CatalogModel[],
  fetchImpl: typeof fetch = fetch
): Promise<CatalogModel[]> {
  try {
    const metadata = new Map(
      (await fetchModelsDevCatalog(provider, fetchImpl)).map((model) => [model.id, model])
    );
    return models.map((model) => {
      const extra = metadata.get(model.id);
      if (extra === undefined) return model;
      return {
        ...model,
        ...(model.label === undefined && extra.label !== undefined ? { label: extra.label } : {}),
        ...(model.pricing === undefined && extra.pricing !== undefined ? { pricing: extra.pricing } : {}),
        ...(model.context === undefined && extra.context !== undefined ? { context: extra.context } : {})
      };
    });
  } catch {
    return models; // enrichment is a bonus, never a requirement
  }
}

/** The mlx-community org listing from the Hugging Face public API. */
async function fetchMlxCommunity(): Promise<CatalogModel[]> {
  const response = await fetch(MLX_COMMUNITY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${MLX_COMMUNITY_URL} -> HTTP ${response.status}`);
  const body = (await response.json()) as JsonRecord[];
  return (Array.isArray(body) ? body : [])
    .map((model) => ({ id: String(model.id ?? "") }))
    .filter((model) => model.id.length > 0);
}

// OpenAI's /v1/models returns far more than chat models; drop the obvious
// non-chat families so pickers and completion stay useful.
const OPENAI_NON_CHAT = [
  "embedding",
  "whisper",
  "tts",
  "dall-e",
  "dalle",
  "realtime",
  "audio",
  "moderation",
  "image",
  "transcribe",
  "search",
  "babbage",
  "davinci"
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chat-usable model ids from an OpenAI `/v1/models` payload. Exported for tests. */
export function parseOpenAiModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0 && !OPENAI_NON_CHAT.some((bad) => id.includes(bad)));
}

/** Model ids from an Anthropic `/v1/models` payload. Exported for tests. */
export function parseAnthropicModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0);
}

/** Chat-usable model ids from a Google `models` payload. Exported for tests. */
export function parseGoogleModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return [];
  return json.models
    .filter((entry) => {
      if (!isRecord(entry)) return false;
      const methods = entry.supportedGenerationMethods;
      // When the methods are present, require generateContent; otherwise keep it.
      return !Array.isArray(methods) || methods.includes("generateContent");
    })
    .map((entry) => {
      const name = isRecord(entry) && typeof entry.name === "string" ? entry.name : "";
      return name.startsWith("models/") ? name.slice("models/".length) : name;
    })
    .filter((id) => id.length > 0);
}

async function fetchOpenAi(): Promise<CatalogModel[]> {
  const key = process.env[defaultKeyEnv("openai") ?? "OPENAI_API_KEY"] ?? "";
  const data = await listOpenAiCompatibleModels({
    baseUrl: "https://api.openai.com",
    apiKey: key
  });
  return parseOpenAiModels({ data })
    .map((id) => ({ id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchAnthropic(): Promise<CatalogModel[]> {
  const key = process.env[defaultKeyEnv("anthropic") ?? "ANTHROPIC_API_KEY"] ?? "";
  const body = await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
    ...providerAuthHeaders("x-api-key", key),
    "anthropic-version": "2023-06-01"
  });
  const data = Array.isArray(body.data) ? (body.data as JsonRecord[]) : [];
  return data
    .map((model) => ({
      id: String(model.id ?? ""),
      ...(typeof model.display_name === "string" ? { label: model.display_name } : {})
    }))
    .filter((model) => model.id.length > 0);
}

async function fetchGoogle(): Promise<CatalogModel[]> {
  const key = process.env[defaultKeyEnv("google") ?? "GEMINI_API_KEY"] ?? "";
  // Key in a header, never the query string: URLs land in logs and traces.
  const body = await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    ...providerAuthHeaders("x-goog-api-key", key)
  });
  const chatIds = new Set(parseGoogleModels(body));
  const data = Array.isArray(body.models) ? (body.models as JsonRecord[]) : [];
  return data
    .map((model) => ({
      id: String(model.name ?? "").replace(/^models\//, ""),
      ...(typeof model.displayName === "string" ? { label: model.displayName } : {}),
      ...(typeof model.inputTokenLimit === "number" ? { context: model.inputTokenLimit } : {})
    }))
    .filter((model) => chatIds.has(model.id));
}

/**
 * The model list of a locally running CLIProxyAPI: the merged catalog of every
 * OAuth account / upstream the proxy is configured with (account ground truth,
 * like the keyed provider listings). Requires the proxy's ingress key.
 */
async function fetchCliproxy(): Promise<CatalogModel[]> {
  const key =
    process.env[defaultKeyEnv("cliproxy") ?? CLIPROXY_API_KEY_ENV] ??
    cliproxyApiKey() ??
    "";
  const data = await listOpenAiCompatibleModels({
    baseUrl: cliproxyBaseUrl(),
    apiKey: key
  });
  return parseOpenAiModels({ data })
    .map((id) => ({ id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchOpenRouter(): Promise<CatalogModel[]> {
  // Public listing; the SDK's placeholder bearer credential is tolerated.
  const data = await listOpenAiCompatibleModels({ baseUrl: "https://openrouter.ai/api" });
  return data
    .map((model) => {
      const pricing = (model.pricing ?? {}) as JsonRecord;
      const input = formatPerMillion(pricing.prompt as string | undefined);
      const output = formatPerMillion(pricing.completion as string | undefined);
      const price =
        input !== undefined && output !== undefined
          ? `${input} in · ${output} out`
          : (input ?? output);
      return {
        id: String(model.id ?? ""),
        ...(typeof model.name === "string" ? { label: model.name } : {}),
        ...(price !== undefined ? { pricing: price } : {}),
        ...(typeof model.context_length === "number" ? { context: model.context_length } : {})
      };
    })
    .filter((model) => model.id.length > 0);
}

/**
 * Fetch `provider`'s catalog live and update the cache. Throws on failure.
 * Keyed providers use their own listing (account ground truth) enriched with
 * models.dev metadata; keyless ones fall back to models.dev entirely.
 */
export async function refreshCatalog(provider: PanelProvider): Promise<CatalogModel[]> {
  let models: CatalogModel[];
  switch (provider) {
    case "openai":
      models = providerListingAvailable(provider)
        ? await enrichWithModelsDev(provider, await fetchOpenAi())
        : await fetchModelsDevCatalog(provider);
      break;
    case "anthropic":
      models = providerListingAvailable(provider)
        ? await enrichWithModelsDev(provider, await fetchAnthropic())
        : await fetchModelsDevCatalog(provider);
      break;
    case "google":
      models = providerListingAvailable(provider)
        ? await enrichWithModelsDev(provider, await fetchGoogle())
        : await fetchModelsDevCatalog(provider);
      break;
    case "openrouter":
      // Public listing with pricing built in; no fallback needed.
      models = await fetchOpenRouter();
      break;
    case "cliproxy":
      // A local proxy: its listing is the only source (models.dev knows
      // nothing about a user's proxy), so a failed fetch degrades to the cache.
      models = await fetchCliproxy();
      break;
    case "mlx":
      models = await fetchMlxCommunity();
      break;
    case "openai-compatible":
      return [];
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown catalog provider: ${String(exhaustive)}`);
    }
  }
  const file = readCatalogFile();
  file.providers[provider] = { fetchedAt: Date.now(), models };
  writeCatalogFile(file);
  return models;
}

/**
 * The catalog for `provider`, cache-first: cached entries immediately, with a
 * refresh only when the cache is stale. Never throws (a failed refresh
 * degrades to the cache).
 */
export async function catalogFor(provider: PanelProvider): Promise<CatalogModel[]> {
  const cached = cachedCatalog(provider);
  if (!catalogStale(provider) || !catalogProviderAvailable(provider)) return cached;
  try {
    return await refreshCatalog(provider);
  } catch {
    return cached;
  }
}

/** A compact display hint for a catalog entry, e.g. "$0.55/M in · 256k ctx". */
export function catalogModelHint(model: CatalogModel): string | undefined {
  const parts: string[] = [];
  if (model.label !== undefined && model.label !== model.id) parts.push(model.label);
  if (model.pricing !== undefined) parts.push(model.pricing);
  if (model.context !== undefined && model.context > 0) {
    parts.push(`${Math.round(model.context / 1000)}k ctx`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ---------------------------------------------------------------------------
// Auth-choice listing — the init / ensemble panel-builder picker
// ---------------------------------------------------------------------------

/** Where a model list came from (drives the picker's source note). */
export type ModelSource = "live" | "models.dev" | "curated";

export type ModelListResult = {
  models: CatalogModel[];
  source: ModelSource;
  /** Present when a live/models.dev fetch failed and the list fell back to curated. */
  degraded?: { reason: string; provider: string };
};

/** Curated fallbacks per auth choice, from the registry's model catalog. */
function curatedFor(choice: AuthChoice): CatalogModel[] {
  const ids = choice === "local" ? LOCAL_CATALOG_REPOS : curatedModels(choice);
  return [...ids].map((id) => ({ id }));
}

/** Dedupe, then put the choice's default model first and sort the rest descending. */
function finalize(ids: string[], choice: AuthChoice): string[] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const preferred = defaultModelForAuthChoice(choice);
  const rest = unique.filter((id) => id !== preferred).sort((a, b) => b.localeCompare(a));
  return unique.includes(preferred) ? [preferred, ...rest] : rest;
}

/** Parse a live discovery payload according to the provider's response shape. */
function parseDiscoveryResponse(shape: string, json: unknown): string[] {
  switch (shape) {
    case "openai":
      return parseOpenAiModels(json);
    case "anthropic":
      return parseAnthropicModels(json);
    case "google":
      return parseGoogleModels(json);
    default:
      return [];
  }
}

async function fetchProviderModels(
  provider: string,
  discovery: NonNullable<ReturnType<typeof providerDiscovery>>,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  env: Record<string, string | undefined>
): Promise<string[]> {
  // cliproxy runs locally, so its base URL honors the ROUTEKIT_CLIPROXY_BASE_URL
  // override; every other provider discovers against its registry default.
  const baseUrl = provider === "cliproxy" ? cliproxyBaseUrl(env) : providerDefaultBaseUrl(provider);
  if (baseUrl === undefined) return [];

  // OpenAI-compatible listings (bearer `/v1/models`) go through the openai
  // SDK against the provider's base URL; only the genuinely non-OpenAI
  // catalog shapes (Anthropic, Google) stay on raw fetch.
  if (discovery.responseShape === "openai" && discovery.auth === "bearer" && discovery.path === "/v1/models") {
    const data = await listOpenAiCompatibleModels({
      baseUrl,
      apiKey: key,
      fetchImpl,
      timeoutMs,
      ...(discovery.extraHeaders !== undefined ? { headers: discovery.extraHeaders } : {})
    });
    return parseOpenAiModels({ data });
  }

  const url = `${baseUrl}${discovery.path}`;
  const headers: Record<string, string> = {
    ...discovery.extraHeaders,
    ...providerAuthHeaders(discovery.auth, key)
  };
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json: unknown = await response.json();
  return parseDiscoveryResponse(discovery.responseShape, json);
}

/**
 * List the models to offer for an auth choice, best source first:
 * - subscriptions (`claude-code`, `codex`) and `local` have no listing
 *   endpoint -> curated registry lists;
 * - API-key providers with a key -> the provider's own listing (the ground
 *   truth of what this account can call), enriched with models.dev metadata;
 * - API-key providers without a key -> the keyless models.dev catalog;
 * - any failure (network, empty list) -> curated, so onboarding always has
 *   something to pick.
 */
export async function listModelsForAuth(
  choice: AuthChoice,
  opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** Force live discovery even when the provider registry defaults the picker to curated. */
    liveDiscovery?: boolean;
  } = {}
): Promise<ModelListResult> {
  const curated = { models: curatedFor(choice), source: "curated" as const };
  const discovery = providerDiscovery(choice);
  const keyEnv = registryDefaultKeyEnv(choice);
  if (discovery === undefined || keyEnv === undefined) return curated;
  if (discovery.pickerDefaultSource === "curated" && opts.liveDiscovery !== true) {
    return curated;
  }

  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider = choice as PanelProvider;
  const key = env[keyEnv];
  if (key === undefined || key.length === 0) {
    try {
      const models = await fetchModelsDevCatalog(provider, fetchImpl);
      return models.length > 0 ? { models, source: "models.dev" } : curated;
    } catch (error) {
      return {
        ...curated,
        degraded: { reason: error instanceof Error ? error.message : String(error), provider: choice }
      };
    }
  }
  try {
    const ids = await fetchProviderModels(
      choice,
      discovery,
      key,
      fetchImpl,
      opts.timeoutMs ?? FETCH_TIMEOUT_MS,
      env
    );
    const ordered = finalize(ids, choice);
    if (ordered.length === 0) return curated;
    const models = await enrichWithModelsDev(
      provider,
      ordered.map((id) => ({ id })),
      fetchImpl
    );
    return { models, source: "live" };
  } catch (error) {
    const keyEnvName = registryDefaultKeyEnv(choice) ?? choice;
    return {
      ...curated,
      degraded: { reason: error instanceof Error ? error.message : String(error), provider: keyEnvName }
    };
  }
}
