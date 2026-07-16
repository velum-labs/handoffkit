import { trimTrailingSlashes } from "@routekit/runtime";

import { subscriptionUsageResponseSchema, SUBSCRIPTION_USAGE_PATH } from "./wire.js";
import type { SubscriptionUsageResponse } from "./wire.js";

export type SubscriptionProxyClientOptions = {
  /** Base URL of a running proxy (no trailing `/usage`). */
  baseUrl: string;
  /** Ingress proxy token. */
  token: string;
  /** Per-request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
};

/**
 * Typed client for a running subscription proxy. Reads the usage endpoint and
 * parses it through the shared wire schema, so consumers never re-declare the
 * response shape. Errors are surfaced as {@link SubscriptionProxyClientError}.
 */
export class SubscriptionProxyClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  private constructor(options: SubscriptionProxyClientOptions) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 3000;
  }

  static open(options: SubscriptionProxyClientOptions): SubscriptionProxyClient {
    return new SubscriptionProxyClient(options);
  }

  /** Whether the proxy answers its health probe. */
  async health(): Promise<boolean> {
    try {
      const response = await this.#get("/health");
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The live per-account usage snapshot, validated against the wire schema. */
  async usage(): Promise<SubscriptionUsageResponse> {
    const response = await this.#get(SUBSCRIPTION_USAGE_PATH);
    if (!response.ok) {
      throw new SubscriptionProxyClientError(
        `proxy usage endpoint returned ${response.status}`,
        response.status
      );
    }
    const parsed = subscriptionUsageResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SubscriptionProxyClientError("proxy usage response did not match the wire schema");
    }
    return parsed.data;
  }

  #get(path: string): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(this.#timeoutMs)
    });
  }
}

export class SubscriptionProxyClientError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SubscriptionProxyClientError";
    this.status = status;
  }
}
