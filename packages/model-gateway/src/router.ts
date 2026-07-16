import { z } from "zod";

import type { Backend, BackendRequestOptions } from "./backend.js";
import {
  API_PROVIDER_IDS,
  ApiProviderSource,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
} from "./provider-source.js";
import type {
  ApiProviderId,
  DiscoveredModel,
  ProviderId,
  ProviderSource
} from "./provider-source.js";

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`unknown model: ${model}`);
    this.name = "UnknownModelError";
  }
}

const providerPolicySchema = z
  .object({
    strategy: z
      .enum(["sticky", "round_robin", "capacity_weighted"])
      .default("capacity_weighted"),
    switchThreshold: z.number().min(0.01).max(1).default(0.9),
    probeIntervalMs: z.number().int().nonnegative().optional(),
    fallbackCooldownSeconds: z.number().nonnegative().optional()
  })
  .strict();

export const routerConfigSchema = z
  .object({
    providers: z
      .object({
        openai: providerPolicySchema.optional(),
        anthropic: providerPolicySchema.optional(),
        google: providerPolicySchema.optional(),
        openrouter: providerPolicySchema.optional(),
        cliproxy: providerPolicySchema.optional(),
        codex: providerPolicySchema.optional(),
        "claude-code": providerPolicySchema.optional()
      })
      .strict()
      .refine((providers) => Object.keys(providers).length > 0, {
        message: "at least one provider must be configured"
      }),
    defaultModel: z.string().min(3).optional()
  })
  .strict();

export type ProviderPolicy = z.infer<typeof providerPolicySchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;

export function normalizeRouterConfigAliases(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const rawProviders = config.providers;
  if (
    typeof rawProviders !== "object" ||
    rawProviders === null ||
    Array.isArray(rawProviders)
  ) {
    return value;
  }
  const providers = rawProviders as Record<string, unknown>;
  const claudeKeys = ["claude-code", "claudeCode", "claude"].filter((key) =>
    Object.hasOwn(providers, key)
  );
  if (claudeKeys.length > 1) {
    throw new Error(
      `router config contains conflicting Claude provider keys: ${claudeKeys.join(", ")}`
    );
  }
  const normalizedProviders = { ...providers };
  const claudeKey = claudeKeys[0];
  if (claudeKey !== undefined && claudeKey !== "claude-code") {
    normalizedProviders["claude-code"] = normalizedProviders[claudeKey];
    delete normalizedProviders[claudeKey];
  }
  return { ...config, providers: normalizedProviders };
}

export function splitNamespacedModel(model: string): {
  provider: ProviderId;
  model: string;
} {
  const separator = model.indexOf("/");
  const source = separator < 0 ? "" : model.slice(0, separator);
  const nativeModel = separator < 0 ? "" : model.slice(separator + 1);
  if (
    !PROVIDER_IDS.includes(source as ProviderId) ||
    nativeModel.length === 0 ||
    nativeModel.startsWith("/")
  ) {
    throw new Error(
      `model "${model}" must use a supported provider/model namespace`
    );
  }
  return { provider: source as ProviderId, model: nativeModel };
}

export function parseRouterConfig(value: unknown): RouterConfig {
  const config = routerConfigSchema.parse(normalizeRouterConfigAliases(value));
  if (config.defaultModel !== undefined) {
    const selected = splitNamespacedModel(config.defaultModel);
    if (config.providers[selected.provider] === undefined) {
      throw new Error(
        `default model provider "${selected.provider}" is not configured`
      );
    }
  }
  return config;
}

type CatalogEntry = {
  publicId: string;
  nativeId: string;
  provider: ProviderId;
  source: ProviderSource;
  capabilities: Readonly<Record<string, string>>;
};

export type CatalogBackendOptions = {
  config: RouterConfig | unknown;
  env?: Readonly<Record<string, string | undefined>>;
  sources?: Partial<Record<ProviderId, ProviderSource>>;
  createApiSource?: (
    provider: ApiProviderId,
    env: Readonly<Record<string, string | undefined>>
  ) => ProviderSource;
  signal?: AbortSignal;
};

function configuredProviderIds(config: RouterConfig): ProviderId[] {
  return PROVIDER_IDS.filter((provider) => config.providers[provider] !== undefined);
}

function isApiProvider(provider: ProviderId): provider is ApiProviderId {
  return API_PROVIDER_IDS.includes(provider as ApiProviderId);
}

function namespaced(provider: ProviderId, model: string): string {
  return `${provider}/${model}`;
}

export class CatalogBackend implements Backend {
  readonly defaultModel: string;
  readonly #entries: ReadonlyMap<string, CatalogEntry>;
  readonly #sources: readonly ProviderSource[];

  private constructor(
    defaultModel: string,
    entries: ReadonlyMap<string, CatalogEntry>,
    sources: readonly ProviderSource[]
  ) {
    this.defaultModel = defaultModel;
    this.#entries = entries;
    this.#sources = sources;
  }

  static async create(options: CatalogBackendOptions): Promise<CatalogBackend> {
    const config = parseRouterConfig(options.config);
    const env = options.env ?? process.env;
    const sources: ProviderSource[] = [];
    const entries = new Map<string, CatalogEntry>();
    try {
      for (const provider of configuredProviderIds(config)) {
        const injected = options.sources?.[provider];
        let source: ProviderSource;
        if (injected !== undefined) {
          source = injected;
        } else if (isApiProvider(provider)) {
          source =
            options.createApiSource?.(provider, env) ??
            new ApiProviderSource({ provider, env });
        } else {
          throw new Error(
            `provider "${provider}" requires enrolled subscription accounts`
          );
        }
        if (source.sourceId !== provider) {
          throw new Error(
            `provider source mismatch: configured "${provider}", received "${source.sourceId}"`
          );
        }
        sources.push(source);
        let discovered: readonly DiscoveredModel[];
        try {
          discovered = await source.discoverModels(options.signal);
        } catch (error) {
          throw new Error(
            `provider "${provider}" discovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }
        if (discovered.length === 0) {
          throw new Error(`provider "${provider}" discovery returned no models`);
        }
        for (const model of discovered) {
          const publicId = namespaced(provider, model.id);
          if (entries.has(publicId)) continue;
          entries.set(publicId, {
            publicId,
            nativeId: model.id,
            provider,
            source,
            capabilities: model.capabilities ?? source.capabilities?.(model.id) ?? {}
          });
        }
      }
      const first = entries.keys().next().value as string | undefined;
      const defaultModel = config.defaultModel ?? first;
      if (defaultModel === undefined) {
        throw new Error("configured providers discovered no models");
      }
      if (!entries.has(defaultModel)) {
        throw new UnknownModelError(defaultModel);
      }
      return new CatalogBackend(defaultModel, entries, sources);
    } catch (error) {
      await Promise.allSettled(sources.map(async (source) => await source.close?.()));
      throw error;
    }
  }

  listModelIds(): readonly string[] {
    return [...this.#entries.keys()];
  }

  servesModel(model: string): boolean {
    return this.#entries.has(model);
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel;
    return this.#entries.has(requested) ? requested : undefined;
  }

  capabilities(model: string): Readonly<Record<string, string>> {
    return this.#entries.get(model)?.capabilities ?? {};
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const entry = this.#entry(this.#requestedModel(body));
    return entry.source.chat(this.#withNativeModel(body, entry.nativeId), signal, options);
  }

  models(): Promise<Response> {
    const data = [...this.#entries.values()].map((entry) => ({
      id: entry.publicId,
      object: "model",
      owned_by: entry.provider,
      capabilities: entry.capabilities
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    const entry = this.#entry(this.#requestedModel(body));
    return entry.source.embeddings(
      this.#withNativeModel(body, entry.nativeId),
      signal
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.#sources.map(async (source) => await source.close?.()));
  }

  #requestedModel(body: unknown): string | undefined {
    return typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : undefined;
  }

  #entry(requested: string | undefined): CatalogEntry {
    const model = requested ?? this.defaultModel;
    const entry = this.#entries.get(model);
    if (entry === undefined) throw new UnknownModelError(model);
    return entry;
  }

  #withNativeModel(body: unknown, nativeModel: string): unknown {
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), model: nativeModel }
      : body;
  }
}

export function isSubscriptionProvider(
  provider: ProviderId
): provider is (typeof SUBSCRIPTION_PROVIDER_IDS)[number] {
  return SUBSCRIPTION_PROVIDER_IDS.includes(
    provider as (typeof SUBSCRIPTION_PROVIDER_IDS)[number]
  );
}
