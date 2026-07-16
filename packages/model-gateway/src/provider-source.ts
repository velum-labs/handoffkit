import {
  PROVIDERS,
  type ProviderAuthStyle,
  type ProviderDiscoveryResponseShape,
  type ProviderInfo,
  type ProviderWireProtocol
} from "@routekit/registry";

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
};

export type ProviderSource = {
  readonly sourceId: ProviderId;
  discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response>;
  embeddings(body: unknown, signal?: AbortSignal): Promise<Response>;
  capabilities?(model: string): Readonly<Record<string, string>>;
  close?(): Promise<void> | void;
};

export type ProviderSourceTransport = (
  url: string,
  init: RequestInit
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(value: unknown, key: "id" | "name" | "slug"): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  const id = value[key].trim();
  if (id.length === 0) return undefined;
  return key === "name" && id.startsWith("models/") ? id.slice("models/".length) : id;
}

export function parseDiscoveredModels(
  shape: ProviderDiscoveryResponseShape,
  payload: unknown
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
    models.push({
      id,
      ...(capabilities !== undefined && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {})
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
    return parseDiscoveredModels(discovery.responseShape, await response.json());
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return this.#backend.chat(body, signal, options);
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#backend.embeddings(body, signal);
  }

  close(): Promise<void> | void {
    return this.#backend.close?.();
  }
}

