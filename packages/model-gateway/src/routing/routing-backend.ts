/**
 * Gateway backend that routes each chat request to a configured provider/model
 * based on Claude Code Router scenario detection.
 */

import type { Backend, BackendRequestOptions } from "../backend.js";
import type { AnthropicRequest } from "../adapters/anthropic.js";
import { anthropicToChat } from "../adapters/anthropic.js";
import { readSessionModelOverrideAsync } from "../session-override.js";
import type { SessionModelOverride } from "../session-override.js";

import {
  classifyProviderError,
  disposeRoutingMlxBackends,
  requireProvider,
  resolveRoutingProviders,
  RoutingProviderError
} from "./providers.js";
import type { ProviderErrorAction } from "./providers.js";
import type { ResolvedRoutingProvider, RoutingProviderSpec } from "./providers.js";
import {
  countRequestTokens,
  fallbackChain,
  parseRouteTarget,
  resolveRoutingDecision,
  resolveRoutingFallback
} from "./routing.js";
import type { RoutingDecision, ScenarioRoutes } from "./types.js";
import { ROUTING_SCENARIOS } from "./types.js";

export type RoutingBackendOptions = {
  routes: ScenarioRoutes;
  providers: readonly RoutingProviderSpec[];
  /** Model id advertised to clients when none is requested. */
  defaultModel?: string;
  /** Optional request headers for background-agent detection. */
  requestHeaders?: Record<string, string | string[] | undefined>;
  /** Called after each routing decision (for CLI `--route` dry-run / observability). */
  onDecision?: (decision: RoutingDecision) => void;
  /** Process env for provider key resolution (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Home directory for session override reads (defaults to `os.homedir()`). */
  homeDir?: string;
  /** Injectable session override reader (tests only). */
  readSessionOverride?: (homeDir?: string) => Promise<SessionModelOverride | undefined>;
};

export class RoutingBackend implements Backend {
  readonly defaultModel: string | undefined;
  readonly #routes: ScenarioRoutes;
  readonly #providerSpecs: readonly RoutingProviderSpec[];
  readonly #providers: Map<string, ResolvedRoutingProvider>;
  readonly #headers: Record<string, string | string[] | undefined>;
  readonly #onDecision: ((decision: RoutingDecision) => void) | undefined;
  readonly #homeDir: string | undefined;
  #sessionOverrideCache: { readAt: number; value: SessionModelOverride | undefined } | null = null;
  readonly #readSessionOverrideFn: (homeDir?: string) => Promise<SessionModelOverride | undefined>;

  constructor(options: RoutingBackendOptions) {
    this.#routes = options.routes;
    this.#providerSpecs = options.providers;
    this.#providers = resolveRoutingProviders(options.providers, options.env);
    this.defaultModel = options.defaultModel ?? parseRouteTarget(options.routes.default).model;
    this.#headers = options.requestHeaders ?? {};
    this.#onDecision = options.onDecision;
    this.#homeDir = options.homeDir;
    this.#readSessionOverrideFn = options.readSessionOverride ?? readSessionModelOverrideAsync;
  }

  /** All configured route targets (for model discovery). */
  listModelIds(): readonly string[] {
    const ids = new Set<string>();
    for (const scenario of ["default", "background", "longContext", "reasoning", "webSearch"] as const) {
      for (const target of fallbackChain(this.#routes, scenario)) {
        ids.add(target.model);
      }
    }
    return [...ids];
  }

  resolveModel(requested: string | undefined): string | undefined {
    return requested ?? this.defaultModel;
  }

  async chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const chat = (body ?? {}) as Record<string, unknown>;
    const decision = await this.#resolveDecision(
      chat as Parameters<typeof resolveRoutingDecision>[0],
      { headers: this.#headers }
    );
    this.#onDecision?.(decision);
    return await this.#invokeWithFallbacks(decision, chat, signal, options);
  }

  async chatAnthropic(
    body: AnthropicRequest,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const chat = anthropicToChat(body, body.model);
    const decision = await this.#resolveDecision(body, { headers: this.#headers });
    this.#onDecision?.(decision);
    return await this.#invokeWithFallbacks(decision, chat, signal, options);
  }

  async close(): Promise<void> {
    this.#sessionOverrideCache = null;
    await disposeRoutingMlxBackends();
  }

  async #readSessionOverride(): Promise<SessionModelOverride | undefined> {
    const now = Date.now();
    if (this.#sessionOverrideCache !== null && now - this.#sessionOverrideCache.readAt < 1000) {
      return this.#sessionOverrideCache.value;
    }
    const value = await this.#readSessionOverrideFn(this.#homeDir);
    this.#sessionOverrideCache = { readAt: now, value };
    return value;
  }

  async #resolveDecision(
    request: Parameters<typeof resolveRoutingDecision>[0],
    options: { headers?: Record<string, string | string[] | undefined> }
  ): Promise<RoutingDecision> {
    const override = await this.#readSessionOverride();
    if (override !== undefined && override.modelId !== null) {
      const model = resolveModelForProviderId(override.modelId, this.#routes, this.#providerSpecs);
      return {
        scenario: "default",
        target: { providerId: override.modelId, model },
        tokenCount: countRequestTokens(request),
        reason: "session model override",
        fallbackIndex: 0
      };
    }
    return resolveRoutingDecision(request, this.#routes, options);
  }

  /**
   * Invoke the routed provider, advancing the scenario fallback chain on classified
   * errors from the primary attempt only.
   *
   * Classifies errors only on the primary attempt (`fallbackIndex === 0`). Once a
   * fallback has fired, any non-2xx is returned as-is — fallback walking is a
   * one-shot escalation, not a retry loop.
   */
  async #invokeWithFallbacks(
    initial: RoutingDecision,
    chat: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: BackendRequestOptions
  ): Promise<Response> {
    let decision = initial;
    let lastError: unknown;
    for (;;) {
      try {
        const response = await this.#invoke(decision, chat, signal, options);
        if (response.ok) return response;
        if (decision.fallbackIndex > 0) return response;

        const action = await classifyResponseError(response);
        if (!shouldAdvanceFallback(action)) return response;

        const next = resolveRoutingFallback(decision, this.#routes, decision.fallbackIndex + 1);
        if (next === undefined) return response;
        decision = next;
        this.#onDecision?.(decision);
        continue;
      } catch (error) {
        lastError = error;
        const next = resolveRoutingFallback(decision, this.#routes, decision.fallbackIndex + 1);
        if (next === undefined) throw error;
        decision = next;
        this.#onDecision?.(decision);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #invoke(
    decision: RoutingDecision,
    chat: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: BackendRequestOptions
  ): Promise<Response> {
    const providerId = decision.target.providerId;
    if (providerId === undefined || providerId.length === 0) {
      throw new RoutingProviderError(
        `route target "${decision.target.model}" has no provider id; use provider,model in routing config`
      );
    }
    const provider = requireProvider(this.#providers, providerId);
    const payload = { ...chat, model: decision.target.model };
    return await provider.backend.chat(payload, signal, options);
  }

  models(signal?: AbortSignal): Promise<Response> {
    const data = this.listModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "fusion-claude-router"
    }));
    void signal;
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported by the routing gateway" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }
}

/**
 * Resolve the upstream model id for a provider when session override is active.
 *
 * @throws {@link RoutingProviderError} when no model can be inferred.
 */
export function resolveModelForProviderId(
  providerId: string,
  routes: ScenarioRoutes,
  providerSpecs: readonly RoutingProviderSpec[]
): string {
  for (const scenario of ROUTING_SCENARIOS) {
    const routeSpec =
      scenario === "default" ? routes.default : routes[scenario as keyof ScenarioRoutes];
    if (typeof routeSpec !== "string") continue;
    const target = parseRouteTarget(routeSpec);
    if (target.providerId === providerId) return target.model;
  }
  const spec = providerSpecs.find((entry) => entry.id === providerId);
  if (spec?.model !== undefined) return spec.model;
  throw new RoutingProviderError(
    `session override provider "${providerId}" has no model in routes or provider spec`
  );
}

/** Whether a classified provider error should advance the scenario fallback chain. */
function shouldAdvanceFallback(action: ProviderErrorAction): boolean {
  return action === "retry" || action === "fallback";
}

async function classifyResponseError(response: Response): Promise<ProviderErrorAction> {
  let body: unknown;
  try {
    const text = await response.clone().text();
    body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }
  return classifyProviderError(response.status, body);
}

/** Format a routing decision for CLI output. */
export function formatRoutingDecision(decision: RoutingDecision): string {
  const provider = decision.target.providerId ?? "(default)";
  return (
    `scenario=${decision.scenario} tokens=${decision.tokenCount} ` +
    `target=${provider},${decision.target.model} fallback=${decision.fallbackIndex} ` +
    `(${decision.reason})`
  );
}

/** Summarise token count for a chat body (used by CLI dry-run). */
export function previewRoutingForChat(
  body: Record<string, unknown>,
  routes: ScenarioRoutes,
  headers?: Record<string, string | string[] | undefined>
): RoutingDecision {
  return resolveRoutingDecision(
    body as Parameters<typeof resolveRoutingDecision>[0],
    routes,
    { headers }
  );
}

/** Summarise routing for an Anthropic body. */
export function previewRoutingForAnthropic(
  body: AnthropicRequest,
  routes: ScenarioRoutes,
  headers?: Record<string, string | string[] | undefined>
): RoutingDecision {
  return resolveRoutingDecision(body, routes, { headers });
}

/** Token count helper exported for tests. */
export { countRequestTokens };
