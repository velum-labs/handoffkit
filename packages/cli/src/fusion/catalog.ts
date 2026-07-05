/**
 * Live provider model catalogs with a small on-disk cache — the data source
 * behind "pick a model" fuzzy pickers and dynamic shell completion. Pickers
 * open instantly on cached entries and refresh in the background
 * (stale-while-revalidate); completion reads the cache only, never the
 * network. Only providers with a usable credential are fetched (OpenRouter's
 * list is public). A fetch failure degrades to the cache (or an empty list) —
 * catalog data is a convenience, never a hard requirement.
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

/** Providers whose model list can be fetched (mlx/openai-compatible have no cloud list). */
export const CATALOG_PROVIDERS: readonly PanelProvider[] = ["openai", "anthropic", "google", "openrouter"];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

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

/** True when `provider`'s catalog can be fetched with the current env. */
export function catalogProviderAvailable(provider: PanelProvider): boolean {
  if (!CATALOG_PROVIDERS.includes(provider)) return false;
  if (provider === "openrouter") return true; // public listing
  const keyEnv = defaultKeyEnv(provider);
  return keyEnv !== undefined && (process.env[keyEnv] ?? "").length > 0;
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

/** Fetch `provider`'s catalog live and update the cache. Throws on failure. */
export async function refreshCatalog(provider: PanelProvider): Promise<CatalogModel[]> {
  let models: CatalogModel[];
  switch (provider) {
    case "openai":
      models = await fetchOpenAi();
      break;
    case "anthropic":
      models = await fetchAnthropic();
      break;
    case "google":
      models = await fetchGoogle();
      break;
    case "openrouter":
      models = await fetchOpenRouter();
      break;
    case "mlx":
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
