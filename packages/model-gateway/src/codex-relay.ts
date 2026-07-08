import type { IncomingHttpHeaders } from "node:http";

import { providerDefaultBaseUrl } from "@fusionkit/registry";

import type { FusionGatewayLogger } from "./logger.js";
import { defaultFusionGatewayLogger } from "./logger.js";

/**
 * The Codex backend relay: lets a Codex client keep its own stock models while
 * pointed at the FusionKit gateway as its (single) model provider.
 *
 * Codex attaches the user's own ChatGPT login (bearer token + account id) to
 * every request it sends its configured provider — i.e. this gateway. The
 * relay uses that:
 *
 * - `GET /v1/models`: forwarded to the ChatGPT Codex backend with the client's
 *   relayed auth, and the live stock catalog is merged behind the fusion/panel
 *   entries — so the picker is always the union of what FusionKit adds and
 *   what Codex would natively offer. When the upstream fetch is impossible
 *   (no relayable auth, offline), the merge falls back to the locally cached
 *   stock catalog snapshot.
 * - `POST /v1/responses` for a model the gateway does not serve locally:
 *   forwarded verbatim (body and auth untouched) to the ChatGPT Codex
 *   backend, so a stock model pick behaves bit-for-bit like plain Codex —
 *   same auth, same billing, same responses.
 *
 * The relay never stores or mints credentials: it only forwards the auth
 * material the client itself attached to the request.
 */

/** One model catalog entry in Codex's own `ModelInfo` wire shape. */
export type CodexCatalogEntry = Record<string, unknown>;

export type CodexRelayOptions = {
  /**
   * ChatGPT Codex backend base URL (no trailing slash). Defaults to the
   * provider registry's `codex` base; override for tests/self-hosted proxies.
   */
  backendUrl?: string;
  /**
   * Build the full picker catalog: the fusion/panel entries first, then the
   * given stock entries merged behind them (deduped by slug). `template` is a
   * schema-true stock entry the fusion entries are cloned from.
   */
  catalog: (template: CodexCatalogEntry, stock: readonly CodexCatalogEntry[]) => CodexCatalogEntry[];
  /**
   * Stock catalog snapshot used when the upstream fetch is impossible
   * (typically the user's `~/.codex/models_cache.json`).
   */
  fallbackStock?: () => CodexCatalogEntry[];
  /** Upstream fetch timeout (ms). Codex itself caps the whole refresh at 5s. */
  timeoutMs?: number;
  logger?: FusionGatewayLogger;
};

/** ChatGPT auth material relayed from the client's own request. */
export type CodexRelayAuth = {
  authorization: string;
  accountId: string;
};

/**
 * Hop-by-hop / transport headers never forwarded upstream. Everything else is
 * relayed verbatim so the upstream sees the exact request Codex built
 * (auth, originator, OpenAI-Beta, session ids, user agent).
 */
const DROP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "proxy-authorization",
  "te",
  "upgrade"
]);

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

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === "string") forwarded[name] = value;
    else if (Array.isArray(value)) forwarded[name] = value.join(", ");
  }
  return forwarded;
}

function entrySlug(entry: CodexCatalogEntry): string | undefined {
  return typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
}

const DEFAULT_RELAY_TIMEOUT_MS = 4500;

export class CodexBackendRelay {
  readonly #backendUrl: string;
  readonly #catalog: CodexRelayOptions["catalog"];
  readonly #fallbackStock: () => CodexCatalogEntry[];
  readonly #timeoutMs: number;
  readonly #logger: FusionGatewayLogger;

  constructor(options: CodexRelayOptions) {
    this.#backendUrl = (options.backendUrl ?? providerDefaultBaseUrl("codex") ?? "").replace(/\/+$/, "");
    this.#catalog = options.catalog;
    this.#fallbackStock = options.fallbackStock ?? (() => []);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
    this.#logger = options.logger ?? defaultFusionGatewayLogger;
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
    if (auth !== undefined) {
      try {
        const upstream = await this.#fetchUpstreamModels(headers, search);
        const template = upstream?.models[0];
        if (upstream !== undefined && template !== undefined) {
          const merged = this.#catalog(template, upstream.models);
          return { models: merged, ...(upstream.etag !== undefined ? { etag: upstream.etag } : {}) };
        }
      } catch (error) {
        this.#logger.warn(
          `fusion: live Codex model catalog unavailable (${error instanceof Error ? error.message : String(error)}); using the local snapshot`
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
  ): Promise<{ models: CodexCatalogEntry[]; etag?: string } | undefined> {
    const response = await fetch(`${this.#backendUrl}/models${search}`, {
      method: "GET",
      headers: forwardHeaders(headers),
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`upstream /models returned ${response.status}`);
    }
    const parsed = (await response.json()) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.filter(
      (entry): entry is CodexCatalogEntry => entry !== null && typeof entry === "object"
    );
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
    return codexRelayAuth(headers) !== undefined;
  }

  /**
   * Forward a Responses request verbatim to the ChatGPT Codex backend: the
   * body and every non-transport header (including the client's own auth) go
   * through untouched, and the upstream response (typically SSE) streams back
   * unchanged. This is exactly the call plain Codex would have made.
   */
  async relayResponses(headers: IncomingHttpHeaders, body: unknown, signal?: AbortSignal): Promise<Response> {
    const forwarded = forwardHeaders(headers);
    forwarded["content-type"] = "application/json";
    return fetch(`${this.#backendUrl}/responses`, {
      method: "POST",
      headers: forwarded,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {})
    });
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
