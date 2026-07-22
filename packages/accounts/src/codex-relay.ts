import type { IncomingHttpHeaders } from "node:http";

import { z } from "zod";

import { providerDefaultBaseUrl } from "@routekit/registry";
import { trimTrailingSlashes } from "@routekit/runtime";

import type { SubscriptionAccountSet } from "./account-set.js";
import { codexModelsSearch, subscriptionProvider } from "./provider.js";
import { forwardRelayHeaders } from "./relay.js";
import type { SubscriptionRelay } from "./relay.js";
import type { SubscriptionAccountSetSnapshot } from "./types.js";

/**
 * The Codex backend relay: lets a Codex client keep its own stock models while
 * pointed at a RouteKit gateway as its model provider.
 *
 * The relay supports two explicit credential trust models:
 *
 * - `client` forwards the ChatGPT login Codex attached to the request.
 * - `accounts` selects from a server-owned {@link SubscriptionAccountSet}.
 *
 * In either mode:
 *
 * - `GET /v1/models`: forwarded to the ChatGPT Codex backend with the client's
 *   relayed auth, and the live stock catalog is merged behind the configured
 *   entries, so the picker is always the union of what the router adds and
 *   what Codex would natively offer. When the upstream fetch is impossible
 *   (no relayable auth, offline), the merge falls back to the locally cached
 *   stock catalog snapshot.
 * - `POST /v1/responses` for a model the gateway does not serve locally:
 *   forwarded verbatim (body and auth untouched) to the ChatGPT Codex
 *   backend, so a stock model pick behaves bit-for-bit like plain Codex —
 *   same auth, same billing, same responses.
 *
 * Client mode never stores or mints credentials. Account-set mode strips
 * ingress auth and injects the selected managed credential.
 */

/** One model catalog entry in Codex's own `ModelInfo` wire shape. */
export type CodexCatalogEntry = Record<string, unknown>;
export type ProviderRelayLogger = {
  warn(message: string): void;
  error(message: string): void;
};

const defaultProviderRelayLogger: ProviderRelayLogger = {
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`)
};

/**
 * The upstream `/models` wire contract, validated structurally. There is no
 * official OpenAPI document or published SDK type for the private ChatGPT
 * Codex backend: the authoritative schema is codex-rs's `ModelInfo`
 * (`codex-rs/protocol/src/openai_models.rs`, serde + ts-rs bindings that are
 * not published to npm — `@openai/codex-sdk` only ships the Threads API), and
 * it deliberately drifts across Codex releases. So validation pins exactly
 * what the relay relies on — the `{ models: [...] }` envelope and each
 * entry's identity (`slug`) — while every other field passes through verbatim
 * (`looseObject`), which is what keeps newer/unknown fields alive on the way
 * to the Codex client that DOES validate the full schema for its own version.
 */
const upstreamModelsEnvelope = z.object({ models: z.array(z.unknown()) });
const stockEntrySchema = z.looseObject({ slug: z.string().min(1) });

/** A validated upstream stock entry: a known `slug`, everything else opaque. */
export type CodexStockEntry = z.infer<typeof stockEntrySchema>;

export type CodexRelayOptions = {
  /**
   * ChatGPT Codex backend base URL (no trailing slash). Defaults to the
   * provider registry's `codex` base; override for tests/self-hosted proxies.
   */
  backendUrl?: string;
  /**
   * Build the full picker catalog: configured entries first, then the given
   * stock entries merged behind them (deduped by slug).
   */
  catalog: (template: CodexCatalogEntry, stock: readonly CodexCatalogEntry[]) => CodexCatalogEntry[];
  /**
   * Stock catalog snapshot used when the upstream fetch is impossible
   * (typically the user's `~/.codex/models_cache.json`).
   */
  fallbackStock?: () => CodexCatalogEntry[];
  /** Upstream fetch timeout (ms). Codex itself caps the whole refresh at 5s. */
  timeoutMs?: number;
  logger?: ProviderRelayLogger;
  /** Credential trust model. Defaults to forwarding the Codex client's auth. */
  auth?: CodexRelayAuthSource;
};

export type CodexRelayAuthSource =
  | { kind: "client" }
  | { kind: "accounts"; accounts: SubscriptionAccountSet };

/** ChatGPT auth material relayed from the client's own request. */
export type CodexRelayAuth = {
  authorization: string;
  accountId: string;
};

/**
 * Extract relayable ChatGPT auth from a request. Codex's ChatGPT-login auth
 * provider always sends the bearer token together with a `chatgpt-account-id`
 * header; the pair is what distinguishes it from a plain API key or a gateway
 * bearer token, so only that combination is ever relayed.
 */
export function codexRelayAuth(headers: IncomingHttpHeaders): CodexRelayAuth | undefined {
  const authorization = headers.authorization;
  const accountId = headers["chatgpt-account-id"];
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  if (typeof accountId !== "string" || accountId.length === 0) return undefined;
  return { authorization, accountId };
}

function entrySlug(entry: CodexCatalogEntry): string | undefined {
  return typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
}

const DEFAULT_RELAY_TIMEOUT_MS = 4500;

export class CodexBackendRelay implements SubscriptionRelay {
  readonly dialect = "codex" as const;
  readonly #backendUrl: string;
  readonly #catalog: CodexRelayOptions["catalog"];
  readonly #fallbackStock: () => CodexCatalogEntry[];
  readonly #timeoutMs: number;
  readonly #logger: ProviderRelayLogger;
  readonly #auth: CodexRelayAuthSource;

  constructor(options: CodexRelayOptions) {
    this.#backendUrl = trimTrailingSlashes(options.backendUrl ?? providerDefaultBaseUrl("codex") ?? "");
    this.#catalog = options.catalog;
    this.#fallbackStock = options.fallbackStock ?? (() => []);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
    this.#logger = options.logger ?? defaultProviderRelayLogger;
    this.#auth = options.auth ?? { kind: "client" };
  }

  /**
   * The merged Codex picker catalog for a `GET /v1/models` request, plus the
   * upstream ETag when the live list was used. With relayable auth the stock
   * list comes from the live ChatGPT backend; otherwise (or on any upstream
   * failure) from the local snapshot. Returns `undefined` when no catalog can
   * be built at all (no stock entry to use as a schema template).
   */
  async mergedCatalog(
    headers: IncomingHttpHeaders,
    search: string
  ): Promise<{ models: CodexCatalogEntry[]; etag?: string } | undefined> {
    const auth = codexRelayAuth(headers);
    if (auth !== undefined || this.#auth.kind === "accounts") {
      try {
        const upstream = await this.#fetchUpstreamModels(headers, search);
        const template = upstream.models[0];
        if (template !== undefined) {
          const merged = this.#catalog(template, upstream.models);
          return { models: merged, ...(upstream.etag !== undefined ? { etag: upstream.etag } : {}) };
        }
      } catch (error) {
        this.#logger.warn(
          `routekit: live Codex model catalog unavailable (${error instanceof Error ? error.message : String(error)}); using the local snapshot`
        );
      }
    }
    const stock = this.#fallbackStock();
    const template = stock[0];
    if (template === undefined) return undefined;
    return { models: this.#catalog(template, stock) };
  }

  async #fetchUpstreamModels(
    headers: IncomingHttpHeaders,
    search: string
  ): Promise<{ models: CodexStockEntry[]; etag?: string }> {
    const request = async (injected?: Record<string, string>): Promise<Response> => {
      const forwarded = forwardRelayHeaders(headers);
      if (injected !== undefined) {
        delete forwarded.authorization;
        delete forwarded.Authorization;
        delete forwarded["chatgpt-account-id"];
        Object.assign(forwarded, injected);
      }
      return fetch(`${this.#backendUrl}/models${codexModelsSearch(search)}`, {
        method: "GET",
        headers: forwarded,
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    };
    const response =
      this.#auth.kind === "client"
        ? await request()
        : await this.#auth.accounts.execute(undefined, (credential) =>
            request(subscriptionProvider("codex").authHeaders(credential))
          );
    if (!response.ok) {
      throw new Error(`upstream /models returned ${response.status}`);
    }
    const envelope = upstreamModelsEnvelope.safeParse(await response.json());
    if (!envelope.success) {
      throw new Error("upstream /models returned an unexpected shape (no models array)");
    }
    // Per-entry salvage: one malformed entry must not cost the whole live
    // catalog, so invalid entries are dropped instead of failing the fetch.
    const models = envelope.data.models.flatMap((entry) => {
      const parsed = stockEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const etag = response.headers.get("etag");
    return { models, ...(etag !== null ? { etag } : {}) };
  }

  /**
   * Whether a `POST /v1/responses` request should be relayed: it names a model
   * the gateway does not serve locally AND carries relayable ChatGPT auth.
   */
  shouldRelayResponses(
    headers: IncomingHttpHeaders,
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean {
    if (model === undefined || model.length === 0) return false;
    if (servesLocally(model)) return false;
    return this.#auth.kind === "accounts" || codexRelayAuth(headers) !== undefined;
  }

  shouldRelay(
    headers: IncomingHttpHeaders,
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean {
    return this.shouldRelayResponses(headers, model, servesLocally);
  }

  /**
   * Forward a Responses request verbatim to the ChatGPT Codex backend: the
   * body and every non-transport header (including the client's own auth) go
   * through untouched, and the upstream response (typically SSE) streams back
   * unchanged. This is exactly the call plain Codex would have made.
   */
  async relayResponses(
    headers: IncomingHttpHeaders,
    body: unknown,
    signal?: AbortSignal,
    options?: Parameters<SubscriptionRelay["relay"]>[3]
  ): Promise<Response> {
    const request = (injected?: Record<string, string>): Promise<Response> => {
      const forwarded = forwardRelayHeaders(headers);
      if (injected !== undefined) {
        delete forwarded.authorization;
        delete forwarded.Authorization;
        delete forwarded["chatgpt-account-id"];
        Object.assign(forwarded, injected);
      }
      forwarded["content-type"] = "application/json";
      return fetch(`${this.#backendUrl}/responses`, {
        method: "POST",
        headers: forwarded,
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {})
      });
    };
    if (this.#auth.kind === "client") return request();
    const model =
      typeof body === "object" &&
      body !== null &&
      "model" in body &&
      typeof body.model === "string"
        ? body.model
        : undefined;
    return this.#auth.accounts.execute(
      model,
      (credential) =>
        request(subscriptionProvider("codex").authHeaders(credential)),
      signal,
      {
        onAttempt: (account) =>
          options?.onAttribution?.({ account })
      }
    );
  }

  relay(
    headers: IncomingHttpHeaders,
    body: Parameters<SubscriptionRelay["relay"]>[1],
    signal?: AbortSignal,
    options?: Parameters<SubscriptionRelay["relay"]>[3]
  ): Promise<Response> {
    return this.relayResponses(headers, body, signal, options);
  }

  snapshot(): SubscriptionAccountSetSnapshot | undefined {
    return this.#auth.kind === "accounts" ? this.#auth.accounts.snapshot() : undefined;
  }

  close(): Promise<void> | undefined {
    return this.#auth.kind === "accounts" ? this.#auth.accounts.close() : undefined;
  }

  /** Merge relayed stock slugs into an OpenAI-shape `data` model list. */
  mergeDataIds(
    data: Array<{ id: string } & Record<string, unknown>>,
    models: readonly CodexCatalogEntry[]
  ): Array<{ id: string } & Record<string, unknown>> {
    const seen = new Set(data.map((entry) => entry.id));
    const merged = [...data];
    for (const entry of models) {
      const slug = entrySlug(entry);
      if (slug === undefined || seen.has(slug)) continue;
      seen.add(slug);
      merged.push({ id: slug, object: "model", owned_by: "codex-relay" });
    }
    return merged;
  }
}
