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

import { defaultKeyEnv } from "./env.js";
import type { PanelProvider } from "./env.js";

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
export const CATALOG_PROVIDERS: readonly PanelProvider[] = ["openai", "anthropic", "google", "openrouter"];

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

async function fetchJson(url: string, headers: Record<string, string>): Promise<JsonRecord> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as JsonRecord;
}

// The models.dev payload covers every provider in one document; memoize it per
// process so refreshing several providers costs one fetch.
let modelsDevBody: Promise<JsonRecord> | undefined;

function fetchModelsDev(): Promise<JsonRecord> {
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
async function fetchModelsDevCatalog(provider: PanelProvider): Promise<CatalogModel[]> {
  const body = await fetchModelsDev();
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
  models: CatalogModel[]
): Promise<CatalogModel[]> {
  try {
    const metadata = new Map((await fetchModelsDevCatalog(provider)).map((model) => [model.id, model]));
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

async function fetchOpenAi(): Promise<CatalogModel[]> {
  const key = process.env[defaultKeyEnv("openai") ?? "OPENAI_API_KEY"] ?? "";
  const body = await fetchJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
  const data = Array.isArray(body.data) ? (body.data as JsonRecord[]) : [];
  return data
    .map((model) => ({ id: String(model.id ?? "") }))
    .filter((model) => model.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchAnthropic(): Promise<CatalogModel[]> {
  const key = process.env[defaultKeyEnv("anthropic") ?? "ANTHROPIC_API_KEY"] ?? "";
  const body = await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
    "x-api-key": key,
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
  const body = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    {}
  );
  const data = Array.isArray(body.models) ? (body.models as JsonRecord[]) : [];
  return data
    .map((model) => ({
      id: String(model.name ?? "").replace(/^models\//, ""),
      ...(typeof model.displayName === "string" ? { label: model.displayName } : {}),
      ...(typeof model.inputTokenLimit === "number" ? { context: model.inputTokenLimit } : {})
    }))
    .filter((model) => model.id.length > 0);
}

async function fetchOpenRouter(): Promise<CatalogModel[]> {
  const body = await fetchJson("https://openrouter.ai/api/v1/models", {});
  const data = Array.isArray(body.data) ? (body.data as JsonRecord[]) : [];
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
