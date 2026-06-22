/**
 * Provider backend interfaces for Claude Code routing.
 *
 * Each configured provider exposes an OpenAI-compatible chat surface the
 * {@link RoutingBackend} delegates to after a scenario resolves.
 */

import { OpenAiBackend, joinPath } from "../backend.js";
import type { Backend } from "../backend.js";

/** Supported upstream provider kinds. */
export const ROUTING_PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible"
] as const;

export type RoutingProviderKind = (typeof ROUTING_PROVIDER_KINDS)[number];

/** Static provider entry from fusion config. */
export type RoutingProviderSpec = {
  id: string;
  provider: RoutingProviderKind;
  baseUrl?: string;
  /** Env var holding the API key (never stored inline). */
  keyEnv?: string;
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
  "openai-compatible": "http://127.0.0.1/v1"
};

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
  const { id, provider, baseUrl, keyEnv } = raw;
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
  const spec: RoutingProviderSpec = { id, provider: provider as RoutingProviderKind };
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
  }
  return spec;
}

function resolveBaseUrl(spec: RoutingProviderSpec): string {
  const raw = spec.baseUrl ?? DEFAULT_BASE_URLS[spec.provider];
  return raw.endsWith("/v1") ? raw : joinPath(raw.replace(/\/+$/, ""), "/v1");
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
    const baseUrl = resolveBaseUrl(spec);
    const apiKey = resolveApiKey(spec, env);
    providers.set(spec.id, {
      id: spec.id,
      kind: spec.provider,
      backend: new OpenAiBackend({ baseUrl, apiKey })
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
