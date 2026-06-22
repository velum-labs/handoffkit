/**
 * Model discovery for the `fusionkit init` picker.
 *
 * For API-key providers we list models live from the provider's `/v1/models`
 * endpoint (when the key is present in the environment); for subscriptions and
 * local models there is no reliable discovery endpoint, so we show a curated
 * catalog. Any failure (missing key, network/timeout, empty list) falls back to
 * the curated list, so onboarding always has something to pick.
 */
import { defaultModelForAuthChoice } from "./panel-auth.js";
import type { AuthChoice } from "./panel-auth.js";

export type ModelSource = "live" | "curated";
export type ModelListResult = { models: string[]; source: ModelSource };

type ApiKeyProvider = "openai" | "anthropic" | "google";

const API_KEY_ENV: Record<ApiKeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY"
};

const DEFAULT_TIMEOUT_MS = 6000;

/** Curated, comprehensive-enough fallbacks per auth choice (best-effort, may drift). */
const CURATED: Record<AuthChoice, string[]> = {
  "claude-code": ["claude-sonnet-4-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-6"],
  anthropic: [
    "claude-sonnet-4-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-3-7-sonnet-latest"
  ],
  codex: ["gpt-5.5", "gpt-5.5-codex", "gpt-5.3-codex", "gpt-5.1-codex"],
  openai: ["gpt-5.5", "gpt-5.1", "gpt-5", "o4-mini", "gpt-4.1", "gpt-4.1-mini"],
  google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  local: [
    "mlx-community/Qwen3-1.7B-4bit",
    "mlx-community/Llama-3.2-1B-Instruct-4bit",
    "mlx-community/gemma-3-1b-it-4bit"
  ]
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

async function fetchProviderModels(
  provider: ApiKeyProvider,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url: string;
    let headers: Record<string, string>;
    switch (provider) {
      case "openai":
        url = "https://api.openai.com/v1/models";
        headers = { authorization: `Bearer ${key}` };
        break;
      case "anthropic":
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
        break;
      case "google":
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
        headers = {};
        break;
      default: {
        const exhaustive: never = provider;
        throw new Error(`unknown provider ${String(exhaustive)}`);
      }
    }
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    switch (provider) {
      case "openai":
        return parseOpenAiModels(json);
      case "anthropic":
        return parseAnthropicModels(json);
      case "google":
        return parseGoogleModels(json);
      default: {
        const exhaustive: never = provider;
        throw new Error(`unknown provider ${String(exhaustive)}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

const API_KEY_CHOICES = new Set<AuthChoice>(["openai", "anthropic", "google"]);

/**
 * List the models to offer for an auth choice: live from the provider when an
 * API key is present, curated otherwise (and on any failure).
 */
export async function listModelsForAuth(
  choice: AuthChoice,
  opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<ModelListResult> {
  const curated = { models: CURATED[choice], source: "curated" as const };
  if (!API_KEY_CHOICES.has(choice)) return curated;

  const provider = choice as ApiKeyProvider;
  const env = opts.env ?? process.env;
  const key = env[API_KEY_ENV[provider]];
  if (key === undefined || key.length === 0) return curated;

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const ids = await fetchProviderModels(provider, key, fetchImpl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const models = finalize(ids, choice);
    return models.length > 0 ? { models, source: "live" } : curated;
  } catch {
    return curated;
  }
}

export const CURATED_MODELS = CURATED;
