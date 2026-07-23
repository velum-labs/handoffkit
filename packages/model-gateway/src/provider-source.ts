import {
  PROVIDERS,
  type ProviderAuthStyle,
  type ProviderDiscoveryResponseShape,
  type ProviderInfo,
  type ProviderWireProtocol
} from "@velum-labs/routekit-registry";
import type {
  ModelReasoningCapabilities,
  ReasoningEffortOption
} from "@velum-labs/routekit-contracts";

import { OpenAiBackend } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "./provider-backends.js";

export const API_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "cliproxy"
] as const;

export const SUBSCRIPTION_PROVIDER_IDS = ["codex", "claude-code"] as const;
export const PROVIDER_IDS = [...API_PROVIDER_IDS, ...SUBSCRIPTION_PROVIDER_IDS] as const;

export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type DiscoveredModel = {
  id: string;
  capabilities?: Readonly<Record<string, string>>;
  reasoning?: ModelReasoningCapabilities;
};

export type ProviderSource = {
  readonly sourceId: ProviderId;
  discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
  capabilities?(model: string): Readonly<Record<string, string>>;
  reasoningCapabilities?(model: string): ModelReasoningCapabilities | undefined;
  close?(): Promise<void> | void;
};

export type ProviderSourceTransport = (
  url: string,
  init: RequestInit
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effortOptions(value: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate): ReasoningEffortOption[] => {
    const record = isRecord(candidate) ? candidate : undefined;
    const id =
      typeof candidate === "string"
        ? candidate
        : typeof record?.effort === "string"
          ? record.effort
          : typeof record?.id === "string"
            ? record.id
            : undefined;
    if (id === undefined || id.length === 0 || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        ...(typeof record?.label === "string" ? { label: record.label } : {}),
        ...(typeof record?.description === "string"
          ? { description: record.description }
          : {}),
        ...(Array.isArray(record?.aliases)
          ? {
              aliases: record.aliases.filter(
                (alias): alias is string =>
                  typeof alias === "string" && alias.length > 0
              )
            }
          : {})
      }
    ];
  });
}

function reasoningWireShape(provider: ProviderId | undefined): string | undefined {
  switch (provider) {
    case "codex":
      return "openai-responses";
    case "anthropic":
    case "claude-code":
      return "anthropic";
    case "google":
      return "google";
    case "openrouter":
      return "openrouter";
    case "openai":
    case "cliproxy":
      return "openai-chat";
    case undefined:
      return undefined;
  }
}

export function parseReasoningCapabilities(
  entry: unknown,
  provider?: ProviderId,
  refreshedAt = new Date().toISOString()
): ModelReasoningCapabilities | undefined {
  if (!isRecord(entry)) return undefined;
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const nested =
    (isRecord(entry.reasoning) ? entry.reasoning : undefined) ??
    (isRecord(capabilities?.reasoning) ? capabilities.reasoning : undefined);
  const efforts = effortOptions(
    entry.supported_reasoning_levels ??
      entry.supported_reasoning_efforts ??
      nested?.efforts ??
      nested?.supported_efforts
  );
  const supportedParameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter(
        (parameter): parameter is string => typeof parameter === "string"
      )
    : [];
  const explicitStatus =
    nested?.status ??
    capabilities?.reasoning_controls ??
    entry.reasoning_controls;
  const supported =
    efforts.length > 0 ||
    supportedParameters.includes("reasoning") ||
    supportedParameters.includes("reasoning_effort") ||
    explicitStatus === "supported";
  const unsupported = explicitStatus === "unsupported" || nested?.supported === false;
  if (!supported && !unsupported && nested === undefined) return undefined;
  const defaultEffort =
    typeof entry.default_reasoning_level === "string"
      ? entry.default_reasoning_level
      : typeof nested?.default_effort === "string"
        ? nested.default_effort
        : typeof nested?.defaultEffort === "string"
          ? nested.defaultEffort
          : undefined;
  const budgetSource = isRecord(nested?.budget) ? nested.budget : undefined;
  const budget =
    budgetSource === undefined
      ? undefined
      : {
          ...(typeof budgetSource.min_tokens === "number"
            ? { minTokens: budgetSource.min_tokens }
            : typeof budgetSource.minTokens === "number"
              ? { minTokens: budgetSource.minTokens }
              : {}),
          ...(typeof budgetSource.max_tokens === "number"
            ? { maxTokens: budgetSource.max_tokens }
            : typeof budgetSource.maxTokens === "number"
              ? { maxTokens: budgetSource.maxTokens }
              : {}),
          ...(typeof budgetSource.default_tokens === "number"
            ? { defaultTokens: budgetSource.default_tokens }
            : typeof budgetSource.defaultTokens === "number"
              ? { defaultTokens: budgetSource.defaultTokens }
              : {})
        };
  return {
    status: unsupported ? "unsupported" : supported ? "supported" : "unknown",
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(typeof nested?.adaptive === "boolean" ? { adaptive: nested.adaptive } : {}),
    ...(reasoningWireShape(provider) !== undefined
      ? { wireShape: reasoningWireShape(provider) }
      : {}),
    provenance: "provider",
    refreshedAt
  };
}

function modelId(value: unknown, key: "id" | "name" | "slug"): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  const id = value[key].trim();
  if (id.length === 0) return undefined;
  return key === "name" && id.startsWith("models/") ? id.slice("models/".length) : id;
}

export function parseDiscoveredModels(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown,
  provider?: ProviderId
): DiscoveredModel[] {
  if (!isRecord(payload)) throw new Error("model discovery returned a non-object payload");
  let entries: unknown[];
  switch (shape) {
    case "openai":
    case "anthropic":
      entries = Array.isArray(payload.data) ? payload.data : [];
      break;
    case "google":
    case "codex":
      entries = Array.isArray(payload.models) ? payload.models : [];
      break;
    default: {
      const unreachable: never = shape;
      throw new Error(`unsupported discovery response shape: ${String(unreachable)}`);
    }
  }
  const key =
    shape === "google" ? "name" : shape === "codex" ? "slug" : "id";
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    const id = modelId(entry, key);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const capabilities =
      isRecord(entry) && isRecord(entry.capabilities)
        ? Object.fromEntries(
            Object.entries(entry.capabilities).flatMap(([name, value]) =>
              typeof value === "string" ? [[name, value]] : []
            )
          )
        : undefined;
    const reasoning = parseReasoningCapabilities(entry, provider);
    models.push({
      id,
      ...(capabilities !== undefined && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {})
    });
  }
  if (models.length === 0) {
    throw new Error(`model discovery returned no usable ${shape} models`);
  }
  return models;
}

function authHeaders(style: ProviderAuthStyle, credential: string): Record<string, string> {
  switch (style) {
    case "bearer":
      return { authorization: `Bearer ${credential}` };
    case "x-api-key":
      return { "x-api-key": credential };
    case "x-goog-api-key":
      return { "x-goog-api-key": credential };
    default: {
      const unreachable: never = style;
      throw new Error(`unsupported provider auth style: ${String(unreachable)}`);
    }
  }
}

function providerUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const baseSegments = url.pathname.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  let overlap = Math.min(baseSegments.length, pathSegments.length);
  while (
    overlap > 0 &&
    !baseSegments
      .slice(baseSegments.length - overlap)
      .every((segment, index) => segment === pathSegments[index])
  ) {
    overlap -= 1;
  }
  url.pathname = `/${[
    ...baseSegments,
    ...pathSegments.slice(overlap)
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function providerBackend(
  protocol: ProviderWireProtocol,
  baseUrl: string,
  apiKey: string,
  headers: Record<string, string>
): Backend {
  const options = { baseUrl, apiKey, headers };
  switch (protocol) {
    case "openai":
      return new OpenAiBackend(options);
    case "anthropic":
      return new AnthropicBackend(options);
    case "google":
      return new GoogleGenAiBackend(options);
    case "codex":
      return new CodexResponsesBackend(options);
    default: {
      const unreachable: never = protocol;
      throw new Error(`unsupported provider wire protocol: ${String(unreachable)}`);
    }
  }
}

function providerMetadata(provider: ApiProviderId): ProviderInfo {
  const info = PROVIDERS[provider];
  if (info?.baseUrl === undefined || info.discovery === undefined || info.wire === undefined) {
    throw new Error(`provider "${provider}" has incomplete registry metadata`);
  }
  return info;
}

function providerCredential(
  provider: ApiProviderId,
  info: ProviderInfo,
  env: Readonly<Record<string, string | undefined>>
): string {
  const keyEnv = info.keyEnv;
  if (keyEnv === undefined) {
    throw new Error(`provider "${provider}" has no registry-defined credential environment`);
  }
  const value = env[keyEnv];
  if (value === undefined || value.length === 0) {
    throw new Error(`provider "${provider}" is missing credential environment variable ${keyEnv}`);
  }
  return value;
}

export type ApiProviderSourceOptions = {
  provider: ApiProviderId;
  env?: Readonly<Record<string, string | undefined>>;
  transport?: ProviderSourceTransport;
};

export class ApiProviderSource implements ProviderSource {
  readonly sourceId: ApiProviderId;
  readonly #info: ProviderInfo;
  readonly #baseUrl: string;
  readonly #credential: string;
  readonly #backend: Backend;
  readonly #transport: ProviderSourceTransport;

  constructor(options: ApiProviderSourceOptions) {
    this.sourceId = options.provider;
    this.#info = providerMetadata(options.provider);
    const env = options.env ?? process.env;
    this.#credential = providerCredential(options.provider, this.#info, env);
    this.#baseUrl =
      (this.#info.baseUrlEnv === undefined ? undefined : env[this.#info.baseUrlEnv]) ??
      this.#info.baseUrl!;
    const wire = this.#info.wire!;
    const headers = this.#info.attributionHeaders ?? {};
    this.#backend = providerBackend(
      wire.protocol,
      providerUrl(this.#baseUrl, wire.basePath),
      this.#credential,
      headers
    );
    this.#transport =
      options.transport ?? (async (url, init) => await fetch(url, init));
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    const discovery = this.#info.discovery!;
    const response = await this.#transport(providerUrl(this.#baseUrl, discovery.path), {
      headers: {
        accept: "application/json",
        ...authHeaders(discovery.auth, this.#credential),
        ...(discovery.extraHeaders ?? {})
      },
      ...(signal !== undefined ? { signal } : {})
    });
    if (!response.ok) {
      throw new Error(`model discovery returned HTTP ${response.status}`);
    }
    return parseDiscoveredModels(
      discovery.responseShape,
      await response.json(),
      this.sourceId
    );
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return this.#backend.chat(body, signal, options);
  }

  embeddings(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return this.#backend.embeddings(body, signal, options);
  }

  close(): Promise<void> | void {
    return this.#backend.close?.();
  }
}

