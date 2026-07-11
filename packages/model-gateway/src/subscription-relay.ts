import type { IncomingHttpHeaders } from "node:http";

import { providerDefaultBaseUrl, subscriptionInfo } from "@fusionkit/registry";
import { trimTrailingSlashes } from "@fusionkit/runtime-utils";

import type { AnthropicRequest } from "./adapters/anthropic.js";
import type { ResponsesRequest } from "./adapters/responses.js";
import type { Backend } from "./backend.js";
import type { SubscriptionPool } from "./subscription-pool.js";
import type { SubscriptionPoolSnapshot } from "./subscription-types.js";

export type SubscriptionRelayDialect = "anthropic" | "codex";

export type SubscriptionRelay = {
  readonly dialect: SubscriptionRelayDialect;
  shouldRelay(
    headers: IncomingHttpHeaders,
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean;
  relay(
    headers: IncomingHttpHeaders,
    body: AnthropicRequest | ResponsesRequest,
    signal?: AbortSignal
  ): Promise<Response>;
  models?(headers: IncomingHttpHeaders, search: string, signal?: AbortSignal): Promise<Response>;
  countTokens?(
    headers: IncomingHttpHeaders,
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response>;
  snapshot?(): SubscriptionPoolSnapshot | undefined;
  close?(): Promise<void> | void;
};

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

export function forwardRelayHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === "string") forwarded[name] = value;
    else if (Array.isArray(value)) forwarded[name] = value.join(", ");
  }
  return forwarded;
}

export type AnthropicRelayOptions = {
  pool: SubscriptionPool;
  backendUrl?: string;
};

function withAnthropicAccount(
  body: AnthropicRequest,
  accountId: string | undefined
): AnthropicRequest {
  if (accountId === undefined) return body;
  const request = body as AnthropicRequest & {
    metadata?: { user_id?: unknown } & Record<string, unknown>;
  };
  const userId = request.metadata?.user_id;
  if (typeof userId !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(userId);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return {
      ...body,
      metadata: {
        ...request.metadata,
        user_id: JSON.stringify({
          ...(parsed as Record<string, unknown>),
          account_uuid: accountId
        })
      }
    } as AnthropicRequest;
  } catch {
    return body;
  }
}

/** Backend sentinel for a gateway whose entire model surface is relay-owned. */
export class RelayOnlyBackend implements Backend {
  readonly defaultModel = undefined;

  listModelIds(): readonly string[] {
    return [];
  }

  servesModel(): boolean {
    return false;
  }

  chat(): Promise<Response> {
    return Promise.resolve(this.#notFound());
  }

  models(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data: [] }), {
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(this.#notFound());
  }

  #notFound(): Response {
    return new Response(
      JSON.stringify({
        error: { message: "request is not handled by a configured subscription relay", type: "not_found" }
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }
}

export class AnthropicBackendRelay implements SubscriptionRelay {
  readonly dialect = "anthropic" as const;
  readonly #pool: SubscriptionPool;
  readonly #backendUrl: string;

  constructor(options: AnthropicRelayOptions) {
    this.#pool = options.pool;
    this.#backendUrl = trimTrailingSlashes(
      options.backendUrl ?? providerDefaultBaseUrl("anthropic") ?? "https://api.anthropic.com"
    );
  }

  shouldRelay(
    _headers: IncomingHttpHeaders,
    model: string | undefined,
    servesLocally: (model: string) => boolean
  ): boolean {
    return model === undefined || model.length === 0 || !servesLocally(model);
  }

  relay(
    headers: IncomingHttpHeaders,
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response> {
    return this.#pool.execute(body.model, (credential) => {
      return fetch(`${this.#backendUrl}/v1/messages`, {
        method: "POST",
        headers: this.#upstreamHeaders(headers, credential.accessToken),
        body: JSON.stringify(withAnthropicAccount(body, credential.accountId)),
        ...(signal !== undefined ? { signal } : {})
      });
    });
  }

  models(
    headers: IncomingHttpHeaders,
    search: string,
    signal?: AbortSignal
  ): Promise<Response> {
    return this.#pool.execute(undefined, (credential) =>
      fetch(`${this.#backendUrl}/v1/models${search}`, {
        headers: this.#upstreamHeaders(headers, credential.accessToken),
        ...(signal !== undefined ? { signal } : {})
      })
    );
  }

  countTokens(
    headers: IncomingHttpHeaders,
    body: AnthropicRequest,
    signal?: AbortSignal
  ): Promise<Response> {
    return this.#pool.execute(body.model, (credential) =>
      fetch(`${this.#backendUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: this.#upstreamHeaders(headers, credential.accessToken),
        body: JSON.stringify(withAnthropicAccount(body, credential.accountId)),
        ...(signal !== undefined ? { signal } : {})
      })
    );
  }

  snapshot(): SubscriptionPoolSnapshot {
    return this.#pool.snapshot();
  }

  close(): Promise<void> {
    return this.#pool.close();
  }

  #upstreamHeaders(
    headers: IncomingHttpHeaders,
    accessToken: string
  ): Record<string, string> {
    const forwarded = forwardRelayHeaders(headers);
    delete forwarded.authorization;
    delete forwarded.Authorization;
    delete forwarded["x-api-key"];
    Object.assign(forwarded, {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": subscriptionInfo("claude-code").oauthBetaHeader ?? "oauth-2025-04-20",
      "content-type": "application/json"
    });
    return forwarded;
  }
}
