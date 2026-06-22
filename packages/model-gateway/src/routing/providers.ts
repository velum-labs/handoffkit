/**
 * Provider backend interfaces for Claude Code routing.
 *
 * Each configured provider exposes an OpenAI-compatible chat surface the
 * {@link RoutingBackend} delegates to after a scenario resolves.
 */

import { OpenAiBackend, joinPath } from "../backend.js";
import type { Backend, BackendRequestOptions } from "../backend.js";

import { disposeAllMlxBackends, getOrCreateMlxBackend } from "./mlx-registry.js";
import { sanitizeProviderRequest } from "./provider-request.js";

/** Supported upstream provider kinds. */
export const ROUTING_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "google-gemini",
  "openai-compatible",
  "openrouter",
  "deepseek",
  "groq",
  "mlx",
  "ollama"
] as const;

export type RoutingProviderKind = (typeof ROUTING_PROVIDER_KINDS)[number];

/** Static provider entry from fusion config. */
export type RoutingProviderSpec = {
  id: string;
  provider: RoutingProviderKind;
  baseUrl?: string;
  /** Env var holding the API key (never stored inline). */
  keyEnv?: string;
  /** Hugging Face repo id for `mlx` providers. */
  model?: string;
};

/** Resolved provider ready to serve chat completions. */
export type ResolvedRoutingProvider = {
  id: string;
  kind: RoutingProviderKind;
  backend: Backend;
};

export class RoutingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingProviderError";
  }
}

const DEFAULT_BASE_URLS: Record<RoutingProviderKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  "google-gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  "openai-compatible": "http://127.0.0.1/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  mlx: "http://127.0.0.1:0",
  ollama: "http://127.0.0.1:11434/v1"
};

const DEFAULT_KEY_ENVS: Partial<Record<RoutingProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-gemini": "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY"
};

/** Providers whose default base URL already includes the OpenAI API prefix. */
const OPENAI_PREFIX_KINDS = new Set<RoutingProviderKind>([
  "anthropic",
  "openai",
  "openai-compatible",
  "openrouter",
  "groq",
  "google",
  "google-gemini",
  "mlx",
  "ollama"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a provider spec from config.
 *
 * @throws {@link RoutingProviderError} on invalid input.
 */
export function parseRoutingProviderSpec(raw: unknown, index: number): RoutingProviderSpec {
  if (!isRecord(raw)) {
    throw new RoutingProviderError(`routing.providers[${index}] must be an object`);
  }
  const { id, provider, baseUrl, keyEnv, model } = raw;
  if (typeof id !== "string" || id.length === 0) {
    throw new RoutingProviderError(`routing.providers[${index}].id must be a non-empty string`);
  }
  if (
    typeof provider !== "string" ||
    !(ROUTING_PROVIDER_KINDS as readonly string[]).includes(provider)
  ) {
    throw new RoutingProviderError(
      `routing.providers[${index}].provider must be one of ${ROUTING_PROVIDER_KINDS.join(", ")}`
    );
  }
  const kind = provider as RoutingProviderKind;
  const spec: RoutingProviderSpec = { id, provider: kind };
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new RoutingProviderError(`routing.providers[${index}].baseUrl must be a non-empty string`);
    }
    spec.baseUrl = baseUrl;
  }
  if (keyEnv !== undefined) {
    if (typeof keyEnv !== "string" || keyEnv.length === 0) {
      throw new RoutingProviderError(`routing.providers[${index}].keyEnv must be a non-empty string`);
    }
    spec.keyEnv = keyEnv;
  } else if (DEFAULT_KEY_ENVS[kind] !== undefined) {
    spec.keyEnv = DEFAULT_KEY_ENVS[kind];
  }
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0) {
      throw new RoutingProviderError(`routing.providers[${index}].model must be a non-empty string`);
    }
    spec.model = model;
  }
  if (kind === "mlx" && spec.model === undefined) {
    throw new RoutingProviderError(
      `routing.providers[${index}] (mlx) requires model (Hugging Face repo id)`
    );
  }
  return spec;
}

/**
 * Resolve the OpenAI-compat API prefix for a provider kind.
 *
 * DeepSeek uses `/chat/completions` directly on the host root
 * ([Your First API Call](https://api-docs.deepseek.com/)). All other Phase 2
 * providers include `/v1` or the Gemini `/v1beta/openai` prefix in their defaults.
 */
export function resolveProviderBaseUrl(spec: RoutingProviderSpec): string {
  if (spec.provider === "mlx") {
    return DEFAULT_BASE_URLS.mlx;
  }
  const raw = (spec.baseUrl ?? DEFAULT_BASE_URLS[spec.provider]).replace(/\/+$/, "");
  if (spec.provider === "deepseek") {
    return raw;
  }
  if (OPENAI_PREFIX_KINDS.has(spec.provider)) {
    if (raw.endsWith("/v1") || raw.endsWith("/openai")) {
      return raw;
    }
    return joinPath(raw, "/v1");
  }
  return raw;
}

function resolveApiKey(spec: RoutingProviderSpec, env: NodeJS.ProcessEnv = process.env): string {
  if (spec.keyEnv === undefined) return "not-needed";
  const key = env[spec.keyEnv];
  if (key === undefined || key.length === 0) {
    throw new RoutingProviderError(
      `routing provider "${spec.id}" requires ${spec.keyEnv} (set the env var or choose a subscription-backed panel entry)`
    );
  }
  return key;
}

/**
 * Wraps {@link OpenAiBackend} with per-provider outbound request shims.
 */
class RoutingProviderBackend implements Backend {
  readonly defaultModel: string | undefined;
  readonly #inner: OpenAiBackend;
  readonly #kind: RoutingProviderKind;

  constructor(inner: OpenAiBackend, kind: RoutingProviderKind, defaultModel?: string) {
    this.#inner = inner;
    this.#kind = kind;
    this.defaultModel = defaultModel ?? inner.defaultModel;
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const payload = sanitizeProviderRequest(this.#kind, body);
    return this.#inner.chat(payload, signal, options);
  }

  models(signal?: AbortSignal): Promise<Response> {
    return this.#inner.models(signal);
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#inner.embeddings(body, signal);
  }
}

/**
 * Build a map of provider id -> resolved backend from config specs.
 *
 * @throws {@link RoutingProviderError} when a provider cannot be resolved.
 */
export function resolveRoutingProviders(
  specs: readonly RoutingProviderSpec[],
  env: NodeJS.ProcessEnv = process.env
): Map<string, ResolvedRoutingProvider> {
  const providers = new Map<string, ResolvedRoutingProvider>();
  for (const spec of specs) {
    if (providers.has(spec.id)) {
      throw new RoutingProviderError(`duplicate routing provider id "${spec.id}"`);
    }
    if (spec.provider === "mlx") {
      const model = spec.model;
      if (model === undefined || model.length === 0) {
        throw new RoutingProviderError(`routing provider "${spec.id}" (mlx) requires model`);
      }
      providers.set(spec.id, {
        id: spec.id,
        kind: spec.provider,
        backend: getOrCreateMlxBackend(model)
      });
      continue;
    }
    const baseUrl = resolveProviderBaseUrl(spec);
    const apiKey = resolveApiKey(spec, env);
    const inner = new OpenAiBackend({
      baseUrl,
      apiKey,
      ...(spec.model !== undefined ? { defaultModel: spec.model } : {})
    });
    providers.set(spec.id, {
      id: spec.id,
      kind: spec.provider,
      backend: new RoutingProviderBackend(inner, spec.provider, spec.model)
    });
  }
  return providers;
}

/** Look up a provider by id; throws when missing. */
export function requireProvider(
  providers: Map<string, ResolvedRoutingProvider>,
  providerId: string
): ResolvedRoutingProvider {
  const provider = providers.get(providerId);
  if (provider === undefined) {
    throw new RoutingProviderError(`unknown routing provider "${providerId}"`);
  }
  return provider;
}

/**
 * Release all MLX backends owned by the routing provider registry.
 */
export async function disposeRoutingMlxBackends(): Promise<void> {
  await disposeAllMlxBackends();
}

export { classifyProviderError } from "./provider-errors.js";
export type { ProviderErrorAction } from "./provider-errors.js";
export {
  sanitizeDeepSeekRequest,
  sanitizeGroqRequest,
  sanitizeProviderRequest
} from "./provider-request.js";
