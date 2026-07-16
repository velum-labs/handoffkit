import {
  AnthropicBackend,
  CodexResponsesBackend
} from "@routekit/gateway";
import type {
  Backend,
  BackendRequestOptions,
  ProviderTransport
} from "@routekit/gateway";
import { subscriptionInfo } from "@routekit/registry";
import type { SubscriptionMode } from "@routekit/registry";

import { SubscriptionAccountSet } from "./account-set.js";
import { subscriptionProvider } from "./provider.js";

export type SubscriptionAccountBackendOptions = {
  accountSet: SubscriptionAccountSet;
  model: string;
};

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function withSubscriptionInstructions(
  mode: SubscriptionMode,
  body: unknown
): Record<string, unknown> {
  const input = bodyRecord(body);
  const info = subscriptionInfo(mode);
  const instructions =
    mode === "claude-code" ? info.spoofSystemPrompt : info.defaultInstructions;
  if (instructions === undefined || instructions.length === 0) return input;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return {
    ...input,
    messages: [{ role: "system", content: instructions }, ...messages]
  };
}

function backendBaseUrl(mode: SubscriptionMode): string {
  const provider = subscriptionProvider(mode);
  return mode === "claude-code"
    ? `${provider.upstreamBaseUrl.replace(/\/$/, "")}/v1`
    : provider.upstreamBaseUrl;
}

/**
 * OpenAI Chat Completions backend backed by a RouteKit subscription pool.
 *
 * The provider-native backend performs wire translation while this wrapper
 * selects and authenticates an account for each request.
 */
export class SubscriptionAccountBackend implements Backend {
  readonly defaultModel: string;
  readonly #accountSet: SubscriptionAccountSet;
  readonly #backend: Backend;

  constructor(options: SubscriptionAccountBackendOptions) {
    this.defaultModel = options.model;
    this.#accountSet = options.accountSet;
    const mode = options.accountSet.mode;
    const provider = subscriptionProvider(mode);
    const transport: ProviderTransport = async (url, init) =>
      await this.#accountSet.execute(this.defaultModel, async (credential) => {
        const headers = new Headers(init.headers);
        headers.delete("x-api-key");
        for (const [name, value] of Object.entries(provider.authHeaders(credential))) {
          headers.set(name, value);
        }
        return await fetch(url, { ...init, headers });
      });
    const backendOptions = {
      baseUrl: backendBaseUrl(mode),
      apiKey: "",
      defaultModel: this.defaultModel,
      transport
    };
    switch (mode) {
      case "claude-code":
        this.#backend = new AnthropicBackend(backendOptions);
        break;
      case "codex":
        this.#backend = new CodexResponsesBackend(backendOptions);
        break;
      default: {
        const exhaustive: never = mode;
        throw new Error(`unsupported subscription kind: ${String(exhaustive)}`);
      }
    }
  }

  listModelIds(): readonly string[] {
    return [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return model === this.defaultModel;
  }

  resolveModel(requested: string | undefined): string | undefined {
    return requested === undefined || requested === this.defaultModel
      ? this.defaultModel
      : undefined;
  }

  capabilities(): Readonly<Record<string, string>> {
    return {
      streaming: "supported",
      tools: "supported",
      reasoning_controls: "supported"
    };
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options?: BackendRequestOptions
  ): Promise<Response> {
    return this.#backend.chat(
      withSubscriptionInstructions(this.#accountSet.mode, body),
      signal,
      options
    );
  }

  models(signal?: AbortSignal): Promise<Response> {
    return this.#backend.models(signal);
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#backend.embeddings(body, signal);
  }
}
