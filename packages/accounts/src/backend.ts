import {
  AnthropicBackend,
  CodexResponsesBackend
} from "@routekit/gateway";
import type {
  Backend,
  BackendRequestOptions,
  DiscoveredModel,
  ProviderSource,
  ProviderTransport
} from "@routekit/gateway";
import { subscriptionInfo } from "@routekit/registry";
import type { SubscriptionMode } from "@routekit/registry";

import { SubscriptionAccountSet } from "./account-set.js";
import { subscriptionProvider } from "./provider.js";

export type SubscriptionAccountBackendOptions = {
  accountSet: SubscriptionAccountSet;
  model?: string;
};

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function modelFromRequest(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { model?: unknown }).model === "string"
      ? (parsed as { model: string }).model
      : undefined;
  } catch {
    return undefined;
  }
}

function claudeSubscriptionMessages(
  messages: readonly unknown[],
  spoofSystemPrompt: string
): unknown[] {
  return [
    { role: "system", content: spoofSystemPrompt },
    ...messages.flatMap((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return [message];
      }
      const record = message as Record<string, unknown>;
      if (record.role !== "system" && record.role !== "developer") return [message];
      if (record.content === spoofSystemPrompt) return [];
      // Claude subscription OAuth accepts only Claude Code's identity prompt in
      // the Anthropic `system` field. Preserve caller instructions in the
      // conversation instead of triggering its generic 429 compatibility guard.
      return [{ ...record, role: "user" }];
    })
  ];
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
    messages:
      mode === "claude-code"
        ? claudeSubscriptionMessages(messages, instructions)
        : [{ role: "system", content: instructions }, ...messages]
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
export class SubscriptionAccountBackend implements Backend, ProviderSource {
  readonly sourceId: SubscriptionMode;
  readonly defaultModel: string | undefined;
  readonly #accountSet: SubscriptionAccountSet;
  readonly #backend: Backend;

  constructor(options: SubscriptionAccountBackendOptions) {
    this.defaultModel = options.model;
    this.#accountSet = options.accountSet;
    const mode = options.accountSet.mode;
    this.sourceId = mode;
    const provider = subscriptionProvider(mode);
    const transport: ProviderTransport = async (url, init) =>
      await this.#accountSet.execute(modelFromRequest(init.body), async (credential) => {
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
      ...(mode === "codex"
        ? { forceStream: true, omitSampling: true }
        : {}),
      ...(this.defaultModel !== undefined
        ? { defaultModel: this.defaultModel }
        : {}),
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
    return this.defaultModel === undefined
      ? this.#accountSet.listModelIds()
      : [this.defaultModel];
  }

  servesModel(model: string): boolean {
    return this.listModelIds().includes(model);
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested === undefined) return this.defaultModel ?? this.listModelIds()[0];
    return this.servesModel(requested) ? requested : undefined;
  }

  capabilities(_model?: string): Readonly<Record<string, string>> {
    return {
      streaming: "supported",
      tools: "supported",
      reasoning_controls: "supported"
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    const models = await this.#accountSet.discoverModels(signal);
    return models.map((id) => ({ id, capabilities: this.capabilities(id) }));
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
