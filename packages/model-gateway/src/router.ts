import { z } from "zod";

import {
  classifyProviderFailure,
  isRetryableProviderFailure,
  parseRetryAfterSeconds
} from "@routekit/contracts";
import type { ModelEndpoint, ProviderFailure } from "@routekit/contracts";

import { OpenAiBackend } from "./backend.js";
import type { Backend, BackendRequestOptions } from "./backend.js";
import { CapacityPool } from "./capacity-pool.js";
import type { CapacityPoolStrategy } from "./capacity-pool.js";
import {
  AnthropicBackend,
  CodexResponsesBackend,
  GoogleGenAiBackend
} from "./provider-backends.js";
import { claudeModelAlias } from "./adapters/anthropic.js";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class UnknownEndpointError extends Error {
  constructor(readonly endpointId: string) {
    super(`unknown endpoint id: ${endpointId}`);
    this.name = "UnknownEndpointError";
  }
}

const endpointCommonSchema = z.object({
  endpointId: z.string().min(1),
  model: z.string().min(1),
  capabilities: z
    .record(
      z.string(),
      z.enum(["supported", "unsupported", "degraded", "unknown"])
    )
    .optional()
});

const urlEndpointSchema = endpointCommonSchema
  .extend({
    instanceId: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    baseUrl: z.url(),
    dialect: z.enum(["openai", "anthropic", "google", "codex"]).default("openai"),
    apiKeyEnv: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    capacity: z.number().positive().optional(),
    account: z.never().optional()
  })
  .strict();

const accountEndpointSchema = endpointCommonSchema
  .extend({
    account: z.enum(["claude-code", "codex"]),
    instanceId: z.never().optional(),
    provider: z.never().optional(),
    baseUrl: z.never().optional(),
    dialect: z.never().optional(),
    apiKeyEnv: z.never().optional(),
    headers: z.never().optional(),
    capacity: z.never().optional()
  })
  .strict();

export const modelEndpointSchema = z.union([
  accountEndpointSchema,
  urlEndpointSchema
]);

const subscriptionAccountPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    strategy: z.enum(["sticky", "round_robin", "capacity_weighted"]).default("sticky"),
    switchThreshold: z.number().min(0.01).max(1).default(0.9),
    probeIntervalMs: z.number().int().nonnegative().optional()
  })
  .strict();

export const routerConfigSchema = z
  .object({
    endpoints: z.array(modelEndpointSchema).min(1),
    strategy: z.enum(["sticky", "round_robin", "capacity_weighted"]).default("capacity_weighted"),
    cooldownMs: z.number().int().nonnegative().default(30_000),
    defaultEndpointId: z.string().min(1).optional(),
    accounts: z
      .object({
        "claude-code": subscriptionAccountPolicySchema.optional(),
        codex: subscriptionAccountPolicySchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type ModelEndpointConfig = z.infer<typeof modelEndpointSchema>;
export type AccountEndpointConfig = z.infer<typeof accountEndpointSchema>;
export type UrlEndpointConfig = z.infer<typeof urlEndpointSchema>;
export type RouterConfig = z.infer<typeof routerConfigSchema>;

export function isAccountEndpointConfig(
  endpoint: ModelEndpointConfig
): endpoint is AccountEndpointConfig {
  return endpoint.account !== undefined;
}

export function normalizeRouterConfigAliases(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const rawAccounts = config.accounts;
  if (typeof rawAccounts !== "object" || rawAccounts === null || Array.isArray(rawAccounts)) {
    return value;
  }
  const accounts = rawAccounts as Record<string, unknown>;
  const claudeKeys = ["claude-code", "claudeCode", "claude"].filter((key) =>
    Object.hasOwn(accounts, key)
  );
  if (claudeKeys.length > 1) {
    throw new Error(
      `router config contains conflicting Claude account keys: ${claudeKeys.join(", ")}`
    );
  }
  const normalizedAccounts = { ...accounts };
  const claudeKey = claudeKeys[0];
  if (claudeKey !== undefined && claudeKey !== "claude-code") {
    normalizedAccounts["claude-code"] = normalizedAccounts[claudeKey];
    delete normalizedAccounts[claudeKey];
  }
  return { ...config, accounts: normalizedAccounts };
}

export function parseRouterConfig(value: unknown): RouterConfig {
  const config = routerConfigSchema.parse(normalizeRouterConfigAliases(value));
  const ids = new Set(config.endpoints.map((endpoint) => endpoint.endpointId));
  const claudeAliases = new Map<string, string>();
  for (const endpointId of ids) {
    const alias = claudeModelAlias(endpointId);
    const previous = claudeAliases.get(alias);
    if (previous !== undefined && previous !== endpointId) {
      throw new Error(
        `endpoint ids "${previous}" and "${endpointId}" collide as Claude model alias "${alias}"`
      );
    }
    claudeAliases.set(alias, endpointId);
  }
  const instanceIds = config.endpoints
    .map((endpoint) => endpoint.instanceId)
    .filter((instanceId): instanceId is string => instanceId !== undefined);
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("endpoint instance ids must be unique");
  }
  const grouped = new Map<string, ModelEndpointConfig[]>();
  for (const endpoint of config.endpoints) {
    const entries = grouped.get(endpoint.endpointId) ?? [];
    entries.push(endpoint);
    grouped.set(endpoint.endpointId, entries);
  }
  for (const [endpointId, endpoints] of grouped) {
    if (endpoints.some(isAccountEndpointConfig) && endpoints.length > 1) {
      throw new Error(`account endpoint cannot be pooled with other instances: ${endpointId}`);
    }
  }
  for (const endpoint of config.endpoints.filter(isAccountEndpointConfig)) {
    if (config.accounts?.[endpoint.account]?.enabled !== true) {
      throw new Error(
        `account endpoint "${endpoint.endpointId}" requires accounts["${endpoint.account}"].enabled`
      );
    }
  }
  if (config.defaultEndpointId !== undefined && !ids.has(config.defaultEndpointId)) {
    throw new Error(`default endpoint is not configured: ${config.defaultEndpointId}`);
  }
  return config;
}

export type EndpointPoolOptions = {
  endpointId: string;
  instances: readonly { config: ModelEndpointConfig; backend: Backend }[];
  strategy?: CapacityPoolStrategy;
  cooldownMs?: number;
};

export class EndpointPool implements Backend {
  readonly defaultModel: string;
  readonly #instances: CapacityPool<{ config: ModelEndpointConfig; backend: Backend }>;
  readonly #cooldownMs: number;

  constructor(options: EndpointPoolOptions) {
    this.defaultModel = options.endpointId;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#instances = new CapacityPool(
      options.instances.map((instance, index) => ({
        id: instance.config.instanceId ?? `${options.endpointId}:${index}`,
        value: instance,
        capacity: instance.config.capacity
      })),
      { strategy: options.strategy }
    );
  }

  listModelIds(): readonly string[] {
    return [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return model === this.defaultModel;
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel;
    return requested === this.defaultModel ? requested : undefined;
  }

  capabilities(): Readonly<Record<string, string>> {
    const records = this.#instances
      .list()
      .map((instance) => instance.value.config.capabilities ?? {});
    const keys = new Set(records.flatMap((record) => Object.keys(record)));
    return Object.fromEntries(
      [...keys].map((key) => [
        key,
        records.every((record) => record[key] === "supported") ? "supported" : "degraded"
      ])
    );
  }

  instanceIds(): readonly string[] {
    return this.#instances.list().map((instance) => instance.id);
  }

  markHealthy(instanceId: string): void {
    this.#instances.markHealthy(instanceId);
  }

  markUnhealthy(instanceId: string): void {
    this.#instances.update(instanceId, { healthy: false });
  }

  markCooldown(instanceId: string, cooldownMs = this.#cooldownMs): void {
    this.#instances.markFailure(instanceId, cooldownMs);
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    return this.#execute(
      (backend, config) =>
        backend.chat(this.#withProviderModel(body, config.model), signal, options),
      this.#stickyKey(options)
    );
  }

  models(): Promise<Response> {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: this.defaultModel,
              object: "model",
              owned_by: "routekit",
              capabilities: this.capabilities()
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#execute(
      (backend, config) =>
        backend.embeddings(this.#withProviderModel(body, config.model), signal),
      "embeddings"
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.#instances.list().map(({ value }) => value.backend.close?.()));
  }

  async #execute(
    operation: (backend: Backend, config: ModelEndpointConfig) => Promise<Response>,
    stickyKey: string
  ): Promise<Response> {
    const excluded = new Set<string>();
    let lastResponse: Response | undefined;
    while (excluded.size < this.#instances.list().length) {
      const lease = this.#instances.acquire(stickyKey, excluded);
      try {
        const response = await operation(lease.value.backend, lease.value.config);
        if (response.ok || !this.#retryable(response)) return response;
        lastResponse = response;
        excluded.add(lease.id);
        this.#instances.markFailure(lease.id, this.#cooldown(response));
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        excluded.add(lease.id);
        this.#instances.markFailure(lease.id, this.#cooldownMs);
        if (excluded.size >= this.#instances.list().length) throw error;
      } finally {
        lease.release();
      }
    }
    return (
      lastResponse ??
      new Response(
        JSON.stringify({ error: { message: "all endpoint instances are unavailable" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );
  }

  #retryable(response: Response): boolean {
    const failure = this.#failure(response);
    return isRetryableProviderFailure(failure.category);
  }

  #failure(response: Response): ProviderFailure {
    return classifyProviderFailure(response.status, `provider returned ${response.status}`, {
      retryAfter: parseRetryAfterSeconds(response.headers.get("retry-after"))
    });
  }

  #cooldown(response: Response): number {
    return (
      parseRetryAfterSeconds(response.headers.get("retry-after")) ??
      this.#cooldownMs / 1000
    ) * 1000;
  }

  #stickyKey(options: BackendRequestOptions): string {
    const header = options.requestContext?.headers["x-routekit-session-id"];
    return typeof header === "string" ? header : (header?.[0] ?? "default");
  }

  #withProviderModel(body: unknown, model: string): unknown {
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), model }
      : body;
  }
}

export type CatalogBackendOptions = {
  config: RouterConfig | unknown;
  env?: Readonly<Record<string, string | undefined>>;
  createBackend?: (endpoint: ModelEndpointConfig, apiKey: string) => Backend;
};

export class CatalogBackend implements Backend {
  readonly defaultModel: string;
  readonly #pools: ReadonlyMap<string, EndpointPool>;
  readonly #endpoints: ReadonlyMap<string, ModelEndpoint>;

  constructor(options: CatalogBackendOptions) {
    const config = parseRouterConfig(options.config);
    const env = options.env ?? process.env;
    const createBackend = options.createBackend ?? providerBackend;
    const grouped = new Map<string, ModelEndpointConfig[]>();
    for (const endpoint of config.endpoints) {
      const group = grouped.get(endpoint.endpointId) ?? [];
      group.push(endpoint);
      grouped.set(endpoint.endpointId, group);
    }
    this.defaultModel = config.defaultEndpointId ?? config.endpoints[0]!.endpointId;
    this.#pools = new Map(
      [...grouped].map(([endpointId, endpoints]) => [
        endpointId,
        new EndpointPool({
          endpointId,
          strategy: config.strategy,
          cooldownMs: config.cooldownMs,
          instances: endpoints.map((endpoint) => {
            const apiKey = endpoint.apiKeyEnv !== undefined ? env[endpoint.apiKeyEnv] : "";
            if (endpoint.apiKeyEnv !== undefined && apiKey === undefined) {
              throw new Error(`missing credential environment variable: ${endpoint.apiKeyEnv}`);
            }
            return { config: endpoint, backend: createBackend(endpoint, apiKey ?? "") };
          })
        })
      ])
    );
    this.#endpoints = new Map(
      [...grouped].map(([endpointId, endpoints]) => {
        const first = endpoints[0]!;
        return [
          endpointId,
          {
            endpointId,
            model: first.model,
            ...(first.provider !== undefined ? { provider: first.provider } : {}),
            ...(first.baseUrl !== undefined ? { baseUrl: first.baseUrl } : {}),
            ...(first.capabilities !== undefined ? { capabilities: first.capabilities } : {})
          }
        ];
      })
    );
  }

  listModelIds(): readonly string[] {
    return [...this.#pools.keys()];
  }

  servesModel(model: string): boolean {
    return this.#pools.has(model);
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel;
    return this.#pools.has(requested) ? requested : undefined;
  }

  capabilities(model: string): Readonly<Record<string, string>> {
    return this.#pools.get(model)?.capabilities() ?? {};
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const requested =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return this.#pool(requested).chat(body, signal, options);
  }

  models(): Promise<Response> {
    const data = [...this.#endpoints.values()].map((endpoint) => ({
      id: endpoint.endpointId,
      object: "model",
      owned_by: endpoint.provider ?? "routekit",
      capabilities: endpoint.capabilities ?? {}
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    const requested =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return this.#pool(requested).embeddings(body, signal);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#pools.values()].map((pool) => pool.close()));
  }

  #pool(requested: string | undefined): EndpointPool {
    const id = this.resolveModel(requested);
    if (id === undefined) throw new UnknownEndpointError(requested ?? "undefined");
    const pool = this.#pools.get(id);
    if (pool === undefined) throw new UnknownEndpointError(id);
    return pool;
  }
}

export function providerBackend(endpoint: ModelEndpointConfig, apiKey: string): Backend {
  if (isAccountEndpointConfig(endpoint)) {
    throw new Error(
      `account endpoint "${endpoint.endpointId}" requires a subscription backend factory`
    );
  }
  const urlEndpoint = endpoint as UrlEndpointConfig;
  const options = {
    baseUrl: urlEndpoint.baseUrl,
    apiKey,
    defaultModel: urlEndpoint.model,
    ...(urlEndpoint.headers !== undefined ? { headers: urlEndpoint.headers } : {})
  };
  switch (urlEndpoint.dialect) {
    case "openai":
      return new OpenAiBackend(options);
    case "anthropic":
      return new AnthropicBackend(options);
    case "google":
      return new GoogleGenAiBackend(options);
    case "codex":
      return new CodexResponsesBackend(options);
    default: {
      const unreachable: never = urlEndpoint.dialect;
      throw new Error(`unsupported provider dialect: ${String(unreachable)}`);
    }
  }
}
