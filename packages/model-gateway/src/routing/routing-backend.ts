/**
 * Gateway backend that routes each chat request to a configured provider/model
 * based on Claude Code Router scenario detection.
 */

import type { Backend, BackendRequestOptions } from "../backend.js";
import type { AnthropicRequest } from "../adapters/anthropic.js";
import { anthropicToChat } from "../adapters/anthropic.js";

import {
  requireProvider,
  resolveRoutingProviders,
  RoutingProviderError
} from "./providers.js";
import type { ResolvedRoutingProvider, RoutingProviderSpec } from "./providers.js";
import {
  countRequestTokens,
  fallbackChain,
  parseRouteTarget,
  resolveRoutingDecision,
  resolveRoutingFallback
} from "./routing.js";
import type { RoutingDecision, ScenarioRoutes } from "./types.js";

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
};

export class RoutingBackend implements Backend {
  readonly defaultModel: string | undefined;
  readonly #routes: ScenarioRoutes;
  readonly #providers: Map<string, ResolvedRoutingProvider>;
  readonly #headers: Record<string, string | string[] | undefined>;
  readonly #onDecision: ((decision: RoutingDecision) => void) | undefined;

  constructor(options: RoutingBackendOptions) {
    this.#routes = options.routes;
    this.#providers = resolveRoutingProviders(options.providers, options.env);
    this.defaultModel = options.defaultModel ?? parseRouteTarget(options.routes.default).model;
    this.#headers = options.requestHeaders ?? {};
    this.#onDecision = options.onDecision;
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
    const decision = resolveRoutingDecision(
      chat as Parameters<typeof resolveRoutingDecision>[0],
      this.#routes,
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
    const decision = resolveRoutingDecision(body, this.#routes, { headers: this.#headers });
    this.#onDecision?.(decision);
    return await this.#invokeWithFallbacks(decision, chat, signal, options);
  }

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
        if (response.ok || decision.fallbackIndex > 0) return response;
        // Primary failed — try fallbacks on non-2xx.
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
