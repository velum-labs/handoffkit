import { z } from "zod";
import { resolveReasoningEffort } from "@routekit/contracts";
import type {
  ModelReasoningCapabilities,
  ReasoningSelection
} from "@routekit/contracts";

import type {
  Backend,
  BackendModelRoute,
  BackendRequestOptions
} from "./backend.js";
import {
  API_PROVIDER_IDS,
  ApiProviderSource,
  PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_IDS
} from "./provider-source.js";
import {
  attachReasoningSelection,
  reasoningSelectionErrorOf,
  reasoningSelectionOf
} from "./adapters/openai-chat-wire.js";
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

const reasoningCapabilityOverrideSchema = z
  .object({
    status: z.enum(["supported", "unsupported", "unknown"]).default("supported"),
    efforts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).optional(),
            description: z.string().min(1).optional(),
            aliases: z.array(z.string().min(1)).optional()
          })
          .strict()
      )
      .optional(),
    defaultEffort: z.string().min(1).optional(),
    budget: z
      .object({
        minTokens: z.number().int().nonnegative().optional(),
        maxTokens: z.number().int().positive().optional(),
        defaultTokens: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    adaptive: z.boolean().optional(),
    wireShape: z.string().min(1).optional()
  })
  .strict()
  .superRefine((capability, context) => {
    const ids = new Set<string>();
    for (const [index, effort] of (capability.efforts ?? []).entries()) {
      if (ids.has(effort.id)) {
        context.addIssue({
          code: "custom",
          path: ["efforts", index, "id"],
          message: `duplicate reasoning effort "${effort.id}"`
        });
      }
      ids.add(effort.id);
    }
    if (
      capability.defaultEffort !== undefined &&
      !ids.has(capability.defaultEffort)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultEffort"],
        message: "default reasoning effort must be listed in efforts"
      });
    }
    if (
      capability.budget?.minTokens !== undefined &&
      capability.budget.maxTokens !== undefined &&
      capability.budget.minTokens > capability.budget.maxTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget"],
        message: "minimum reasoning budget cannot exceed maximum"
      });
    }
  });

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
    defaultModel: z.string().min(3).optional(),
    reasoningCapabilities: z
      .record(z.string().min(3), reasoningCapabilityOverrideSchema)
      .optional()
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
  reasoning?: ModelReasoningCapabilities;
};

export type CatalogModelInfo = {
  id: string;
  provider: ProviderId;
  nativeModel: string;
  accountClass: "api-key" | "subscription" | "proxy";
  billingMode: "metered-api" | "subscription" | "upstream-managed";
  default: boolean;
  capabilities: Readonly<Record<string, string>>;
  reasoning: ModelReasoningCapabilities | null;
};

function routeBilling(provider: ProviderId): Pick<
  CatalogModelInfo,
  "accountClass" | "billingMode"
> {
  switch (provider) {
    case "openai":
    case "anthropic":
    case "google":
    case "openrouter":
      return { accountClass: "api-key", billingMode: "metered-api" };
    case "codex":
    case "claude-code":
      return { accountClass: "subscription", billingMode: "subscription" };
    case "cliproxy":
      return { accountClass: "proxy", billingMode: "upstream-managed" };
    default: {
      const unreachable: never = provider;
      throw new Error(`unsupported route provider: ${String(unreachable)}`);
    }
  }
}

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
          const override = config.reasoningCapabilities?.[publicId];
          const reasoning =
            override !== undefined
              ? {
                  ...override,
                  provenance: "config" as const
                }
              : model.reasoning ?? source.reasoningCapabilities?.(model.id);
          entries.set(publicId, {
            publicId,
            nativeId: model.id,
            provider,
            source,
            capabilities: model.capabilities ?? source.capabilities?.(model.id) ?? {},
            ...(reasoning !== undefined ? { reasoning } : {})
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

  modelInfo(model: string): CatalogModelInfo | undefined {
    const entry = this.#entries.get(model);
    if (entry === undefined) return undefined;
    return {
      id: entry.publicId,
      provider: entry.provider,
      nativeModel: entry.nativeId,
      ...routeBilling(entry.provider),
      default: entry.publicId === this.defaultModel,
      capabilities: entry.capabilities,
      reasoning: entry.reasoning ?? null
    };
  }

  async providerStatuses(
    signal?: AbortSignal
  ): Promise<
    Array<{ provider: string; ok: boolean; models: string[]; error?: string }>
  > {
    return await Promise.all(
      this.#sources.map(async (source) => {
        try {
          const models = await source.discoverModels(signal);
          if (models.length === 0) {
            return {
              provider: source.sourceId,
              ok: false,
              models: [],
              error: "live discovery returned no models"
            };
          }
          return {
            provider: source.sourceId,
            ok: true,
            models: models.map((model) => namespaced(source.sourceId, model.id))
          };
        } catch (error) {
          return {
            provider: source.sourceId,
            ok: false,
            models: [],
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
  }

  servesModel(model: string): boolean {
    return this.#entries.has(model);
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel;
    return this.#entries.has(requested) ? requested : undefined;
  }

  resolveModelRoute(
    requested: string | undefined,
    nativeProvider?: string
  ): BackendModelRoute | undefined {
    const publicId = requested ?? this.defaultModel;
    const exact = this.#entries.get(publicId);
    if (exact !== undefined) return this.#modelRoute(exact);
    if (nativeProvider === undefined || requested === undefined) return undefined;
    for (const entry of this.#entries.values()) {
      if (entry.provider === nativeProvider && entry.nativeId === requested) {
        return this.#modelRoute(entry);
      }
    }
    return undefined;
  }

  capabilities(model: string): Readonly<Record<string, string>> {
    return this.#entries.get(model)?.capabilities ?? {};
  }

  reasoningCapabilities(model: string): ModelReasoningCapabilities | undefined {
    return this.#entries.get(model)?.reasoning;
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    const entry = this.#entry(this.#requestedModel(body));
    const selectionError = reasoningSelectionErrorOf(body);
    if (selectionError !== undefined) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "invalid_reasoning_control",
              message: selectionError
            }
          },
          { status: 400 }
        )
      );
    }
    const selection = this.#validatedReasoning(entry, reasoningSelectionOf(body));
    if (typeof selection === "string") {
      return Promise.resolve(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "unsupported_reasoning_control",
              message: selection
            }
          },
          { status: 400 }
        )
      );
    }
    const nativeBody = this.#withNativeModel(body, entry.nativeId);
    if (
      nativeBody !== null &&
      typeof nativeBody === "object" &&
      !Array.isArray(nativeBody)
    ) {
      attachReasoningSelection(
        nativeBody as Record<PropertyKey, unknown>,
        selection
      );
      if (selection.mode === "effort") {
        (nativeBody as Record<string, unknown>).reasoning_effort =
          selection.effort;
      }
    }
    return entry.source.chat(nativeBody, signal, {
      ...options,
      ...(entry.reasoning !== undefined
        ? { reasoningCapabilities: entry.reasoning }
        : {})
    });
  }

  models(): Promise<Response> {
    const data = [...this.#entries.values()].map((entry) => ({
      id: entry.publicId,
      object: "model",
      owned_by: entry.provider,
      capabilities: entry.capabilities,
      ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {})
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

  #modelRoute(entry: CatalogEntry): BackendModelRoute {
    return {
      publicId: entry.publicId,
      nativeId: entry.nativeId,
      provider: entry.provider,
      ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {})
    };
  }

  #validatedReasoning(
    entry: CatalogEntry,
    selection: ReasoningSelection
  ): ReasoningSelection | string {
    if (selection.mode === "auto" || selection.mode === "disabled") {
      return selection;
    }
    const capability = entry.reasoning;
    if (capability === undefined || capability.status === "unknown") {
      return `model "${entry.publicId}" has no discovered reasoning controls`;
    }
    if (capability.status === "unsupported") {
      return `model "${entry.publicId}" does not support reasoning controls`;
    }
    if (selection.mode === "effort") {
      const effort = resolveReasoningEffort(capability, selection.effort);
      return effort === undefined
        ? `reasoning effort "${selection.effort}" is not supported by model "${entry.publicId}"`
        : { mode: "effort", effort };
    }
    if (selection.mode === "adaptive") {
      return capability.adaptive === true
        ? selection
        : `adaptive reasoning is not supported by model "${entry.publicId}"`;
    }
    const budget = capability.budget;
    if (budget === undefined) {
      return `reasoning token budgets are not supported by model "${entry.publicId}"`;
    }
    if (
      budget.minTokens !== undefined &&
      selection.budgetTokens < budget.minTokens
    ) {
      return `reasoning budget must be at least ${budget.minTokens} tokens`;
    }
    if (
      budget.maxTokens !== undefined &&
      selection.budgetTokens > budget.maxTokens
    ) {
      return `reasoning budget must be at most ${budget.maxTokens} tokens`;
    }
    return selection;
  }
}

export function isSubscriptionProvider(
  provider: ProviderId
): provider is (typeof SUBSCRIPTION_PROVIDER_IDS)[number] {
  return SUBSCRIPTION_PROVIDER_IDS.includes(
    provider as (typeof SUBSCRIPTION_PROVIDER_IDS)[number]
  );
}
