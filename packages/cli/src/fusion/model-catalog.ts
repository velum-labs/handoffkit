/**
 * Model discovery for the `fusionkit init` picker.
 *
 * For API-key providers we list models live from the provider's `/v1/models`
 * endpoint (when the key is present in the environment); for subscriptions and
 * local models there is no reliable discovery endpoint, so we show a curated
 * catalog. Any failure (missing key, network/timeout, empty list) falls back to
 * the curated list, so onboarding always has something to pick.
 */
import {
  curatedModels,
  defaultKeyEnv,
  providerDefaultBaseUrl,
  providerDiscovery
} from "@fusionkit/registry";

import { LOCAL_CATALOG_REPOS } from "./local-catalog.js";
import { defaultModelForAuthChoice } from "./panel-auth.js";
import type { AuthChoice } from "./panel-auth.js";

export type ModelSource = "live" | "curated";
export type ModelListResult = { models: string[]; source: ModelSource };

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Curated, comprehensive-enough fallbacks per auth choice, from the registry's
 * model catalog (shared with Python onboarding). Local models come from the
 * hardware-aware local catalog; the interactive picker enriches these with
 * download status + RAM fit.
 */
const CURATED: Record<AuthChoice, string[]> = {
  "claude-code": [...curatedModels("claude-code")],
  anthropic: [...curatedModels("anthropic")],
  codex: [...curatedModels("codex")],
  openai: [...curatedModels("openai")],
  google: [...curatedModels("google")],
  openrouter: [...curatedModels("openrouter")],
  local: [...LOCAL_CATALOG_REPOS]
};

// OpenAI's /v1/models returns far more than chat models; drop the obvious
// non-chat families so the picker stays useful.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dedupe, then put the choice's default model first and sort the rest descending. */
function finalize(ids: string[], choice: AuthChoice): string[] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const preferred = defaultModelForAuthChoice(choice);
  const rest = unique.filter((id) => id !== preferred).sort((a, b) => b.localeCompare(a));
  return unique.includes(preferred) ? [preferred, ...rest] : rest;
}

export function parseOpenAiModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0 && !OPENAI_NON_CHAT.some((bad) => id.includes(bad)));
}

export function parseAnthropicModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data.map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : ""));
}

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
    });
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
  timeoutMs: number
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = providerDefaultBaseUrl(provider);
    if (baseUrl === undefined) return [];
    let url = `${baseUrl}${discovery.path}`;
    const headers: Record<string, string> = { ...discovery.extraHeaders };
    switch (discovery.auth) {
      case "bearer":
        headers.authorization = `Bearer ${key}`;
        break;
      case "x-api-key":
        headers["x-api-key"] = key;
        break;
      case "x-goog-api-key":
        headers["x-goog-api-key"] = key;
        break;
      case "query-key":
        url = `${url}?key=${encodeURIComponent(key)}`;
        break;
      default: {
        const exhaustive: never = discovery.auth;
        throw new Error(`unknown discovery auth style ${String(exhaustive)}`);
      }
    }
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    return parseDiscoveryResponse(discovery.responseShape, json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List the models to offer for an auth choice: live from the provider when it
 * has a discovery capability in the provider registry and an API key is present
 * in the environment; curated otherwise (and on any failure).
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
  const curated = { models: CURATED[choice], source: "curated" as const };
  const discovery = providerDiscovery(choice);
  const keyEnv = defaultKeyEnv(choice);
  if (discovery === undefined || keyEnv === undefined) return curated;
  if (discovery.pickerDefaultSource === "curated" && opts.liveDiscovery !== true) {
    return curated;
  }

  const env = opts.env ?? process.env;
  const key = env[keyEnv];
  if (key === undefined || key.length === 0) return curated;

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const ids = await fetchProviderModels(
      choice,
      discovery,
      key,
      fetchImpl,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const models = finalize(ids, choice);
    return models.length > 0 ? { models, source: "live" } : curated;
  } catch {
    return curated;
  }
}

export const CURATED_MODELS = CURATED;
