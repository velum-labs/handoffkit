/**
 * Provider status resolution and connectivity checks for the routing dashboard.
 */

import type { ProviderStatus, RoutingProviderKind, RoutingProviderSpec } from "./types";

const DEFAULT_BASE_URLS: Record<RoutingProviderKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  "google-gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  "openai-compatible": "http://127.0.0.1/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1"
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

const OPENAI_PREFIX_KINDS = new Set<RoutingProviderKind>([
  "anthropic",
  "openai",
  "openai-compatible",
  "openrouter",
  "groq",
  "google",
  "google-gemini"
]);

function joinPath(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

/** Resolve the OpenAI-compat API prefix for a provider kind. */
export function resolveProviderBaseUrl(spec: RoutingProviderSpec): string {
  const raw = (spec.baseUrl ?? DEFAULT_BASE_URLS[spec.provider]).replace(/\/+$/, "");
  if (spec.provider === "deepseek") return raw;
  if (OPENAI_PREFIX_KINDS.has(spec.provider)) {
    if (raw.endsWith("/v1") || raw.endsWith("/openai")) return raw;
    return joinPath(raw, "/v1");
  }
  return raw;
}

function resolveKeyEnv(spec: RoutingProviderSpec): string | undefined {
  return spec.keyEnv ?? DEFAULT_KEY_ENVS[spec.provider];
}

function hasApiKey(keyEnv: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (keyEnv === undefined) return true;
  const value = env[keyEnv];
  return value !== undefined && value.length > 0;
}

function modelsUrl(baseUrl: string, kind: RoutingProviderKind): string {
  if (kind === "deepseek") return joinPath(baseUrl, "/models");
  if (kind === "anthropic") return joinPath(baseUrl, "/models");
  return joinPath(baseUrl, "/models");
}

const PING_TIMEOUT_MS = 4_000;

/**
 * Ping a provider's models endpoint. Returns reachability without throwing.
 * Skips the network call when the API key env var is missing.
 */
export async function pingProvider(
  spec: RoutingProviderSpec,
  env: NodeJS.ProcessEnv = process.env
): Promise<Pick<ProviderStatus, "reachable" | "pingMs" | "pingError">> {
  const keyEnv = resolveKeyEnv(spec);
  if (keyEnv !== undefined && !hasApiKey(keyEnv, env)) {
    return { reachable: null, pingMs: null, pingError: `${keyEnv} not set` };
  }

  const baseUrl = resolveProviderBaseUrl(spec);
  const url = modelsUrl(baseUrl, spec.provider);
  const headers: Record<string, string> = {};
  if (keyEnv !== undefined) {
    const key = env[keyEnv];
    if (key !== undefined) headers.authorization = `Bearer ${key}`;
  }

  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    });
    const pingMs = Math.round(performance.now() - started);
    if (response.ok || response.status === 401 || response.status === 403) {
      return { reachable: true, pingMs, pingError: undefined };
    }
    return { reachable: false, pingMs, pingError: `HTTP ${response.status}` };
  } catch (error) {
    return {
      reachable: false,
      pingMs: Math.round(performance.now() - started),
      pingError: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Build a provider status row (without awaiting connectivity). */
export function providerStatusBase(
  spec: RoutingProviderSpec,
  env: NodeJS.ProcessEnv = process.env
): Omit<ProviderStatus, "reachable" | "pingMs" | "pingError"> {
  const keyEnv = resolveKeyEnv(spec);
  return {
    id: spec.id,
    kind: spec.provider,
    baseUrl: resolveProviderBaseUrl(spec),
    keyEnv,
    hasKey: hasApiKey(keyEnv, env)
  };
}

/** Resolve full provider status including an optional connectivity ping. */
export async function resolveProviderStatus(
  spec: RoutingProviderSpec,
  options: { ping?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<ProviderStatus> {
  const base = providerStatusBase(spec, options.env);
  if (options.ping === false) {
    return { ...base, reachable: null, pingMs: null, pingError: undefined };
  }
  const ping = await pingProvider(spec, options.env);
  return { ...base, ...ping };
}
