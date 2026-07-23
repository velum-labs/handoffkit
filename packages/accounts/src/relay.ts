import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";

import { providerDefaultBaseUrl, subscriptionInfo } from "@velum-labs/routekit-registry";
import { trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type {
  AnthropicRequest,
  Backend,
  ProviderRelay,
  ProviderRelayDialect,
  ResponsesRequest
} from "@velum-labs/routekit-gateway";

import type { SubscriptionAccountSet } from "./account-set.js";
import type { SubscriptionAccountSetSnapshot } from "./types.js";

export type SubscriptionRelayDialect = ProviderRelayDialect;

export type SubscriptionRelay = ProviderRelay & {
  snapshot?(): SubscriptionAccountSetSnapshot | undefined;
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
  const forwarded = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue;
    const normalized =
      typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : undefined;
    if (normalized === undefined) continue;
    Object.defineProperty(forwarded, name, {
      value: normalized,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return forwarded;
}

function mergeHeaderTokens(current: string | undefined, required: string): string {
  const tokens = new Set(
    [current, required]
      .flatMap((value) => value?.split(",") ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
  return [...tokens].join(",");
}

export type AnthropicRelayOptions = {
  accounts: SubscriptionAccountSet;
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
  readonly #accounts: SubscriptionAccountSet;
  readonly #backendUrl: string;

  constructor(options: AnthropicRelayOptions) {
    this.#accounts = options.accounts;
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
    signal?: AbortSignal,
    options?: Parameters<ProviderRelay["relay"]>[3]
  ): Promise<Response> {
    const operationId = randomUUID();
    return this.#accounts.execute(body.model, (credential) => {
      const upstreamHeaders = this.#upstreamHeaders(headers, credential.accessToken);
      return fetch(`${this.#backendUrl}/v1/messages`, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(withAnthropicAccount(body, credential.accountId)),
        ...(signal !== undefined ? { signal } : {})
      });
    }, signal, {
      onAttempt: (account) =>
        options?.onAttribution?.({
          accountAttempt: { operationId, seat: account.seat }
        })
    });
  }

  models(
    headers: IncomingHttpHeaders,
    search: string,
    signal?: AbortSignal
  ): Promise<Response> {
    return this.#accounts.execute(undefined, (credential) =>
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
    return this.#accounts.execute(body.model, (credential) =>
      fetch(`${this.#backendUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: this.#upstreamHeaders(headers, credential.accessToken),
        body: JSON.stringify(withAnthropicAccount(body, credential.accountId)),
        ...(signal !== undefined ? { signal } : {})
      })
    );
  }

  snapshot(): SubscriptionAccountSetSnapshot {
    return this.#accounts.snapshot();
  }

  close(): Promise<void> {
    return this.#accounts.close();
  }

  #upstreamHeaders(
    headers: IncomingHttpHeaders,
    accessToken: string
  ): Record<string, string> {
    const forwarded = forwardRelayHeaders(headers);
    delete forwarded.authorization;
    delete forwarded.Authorization;
    delete forwarded["x-api-key"];
    const oauthBeta =
      subscriptionInfo("claude-code").oauthBetaHeader ?? "oauth-2025-04-20";
    Object.assign(forwarded, {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": mergeHeaderTokens(
        forwarded["anthropic-beta"],
        oauthBeta
      ),
      "content-type": "application/json"
    });
    return forwarded;
  }
}
