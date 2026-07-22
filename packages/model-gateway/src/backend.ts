/**
 * The gateway's model backend. The default HTTP implementation speaks
 * OpenAI-compatible Chat Completions, but provider-native implementations can
 * adapt another wire protocol behind the same interface. The backend is a thin
 * `fetch` wrapper that returns the upstream `Response` unchanged, so the chat
 * surface can stream straight through and the dialect adapters can consume the
 * same core without a second abstraction.
 */
import type {
  ModelReasoningCapabilities,
  RequestAttribution
} from "@routekit/contracts";
import { reasoningSelectionOf } from "./adapters/openai-chat-wire.js";

export type BackendModelRoute = {
  /** Stable RouteKit catalog id (`provider/model`). */
  publicId: string;
  /** Model id understood by the provider's native API. */
  nativeId: string;
  /** Configured provider that owns the model. */
  provider: string;
  reasoning?: ModelReasoningCapabilities;
};

export type Backend = {
  /** Model id sent to the backend when a request omits one. */
  readonly defaultModel: string | undefined;
  /**
   * All model ids the backend advertises for discovery: the default model
   * first, then any native passthrough models. When present, the gateway lists
   * these in `/v1/models` (both OpenAI and Anthropic shapes) so they appear in
   * the tool's picker. Absent means single-model (just `defaultModel`).
   */
  listModelIds?(): readonly string[];
  /**
   * Resolve a client-requested model id to the upstream id the backend should
   * actually run. When absent the gateway falls back to `defaultModel` (the
   * historical single-model behaviour). A multi-model backend returns the
   * requested id when it recognises a native model so the gateway can route it
   * to its provider.
   */
  resolveModel?(requested: string | undefined): string | undefined;
  /**
   * Resolve a model together with its provider/native identity. An exact
   * public id always wins. When `nativeProvider` is supplied, a bare native id
   * may resolve only inside that provider; this powers provider-native client
   * aliases without making bare ids valid on RouteKit's global API surface.
   */
  resolveModelRoute?(
    requested: string | undefined,
    nativeProvider?: string
  ): BackendModelRoute | undefined;
  /**
   * Whether the backend serves this exact model id itself. Unlike
   * {@link resolveModel} — which folds unknown
   * ids into the default — this distinguishes "mine" from "unknown", so the
   * gateway can hand unknown ids to a relay (e.g. the Codex backend relay)
   * instead of silently routing them to the default.
   */
  servesModel?(model: string): boolean;
  /** Capabilities advertised for a model id. */
  capabilities?(model: string): Readonly<Record<string, string>>;
  /** Structured reasoning controls advertised for a model id. */
  reasoningCapabilities?(model: string): ModelReasoningCapabilities | undefined;
  /** POST <base>/chat/completions — supports streaming (SSE) upstream. */
  chat(body: unknown, signal?: AbortSignal, options?: BackendRequestOptions): Promise<Response>;
  /** GET <base>/models. */
  models(signal?: AbortSignal): Promise<Response>;
  /** POST <base>/embeddings. */
  embeddings(body: unknown, signal?: AbortSignal): Promise<Response>;
  /** Release any owned resources (e.g. a managed model process). Optional. */
  close?(): Promise<void> | void;
};

export type BackendRequestOptions = {
  modelCallId?: string;
  reasoningCapabilities?: ModelReasoningCapabilities;
  /** Request-local, sanitized attribution updates from routing/backends. */
  onAttribution?: (update: Partial<RequestAttribution>) => void;
  /**
   * Neutral request context captured at the HTTP boundary. Backends may
   * interpret their own namespaced headers; the gateway does not.
   */
  requestContext?: {
    headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  };
  /**
   * The caller will wrap the returned stream in a dialect translator
   * (Anthropic / Responses) that emits its own keepalive.
   */
  translated?: boolean;
};

export type OpenAiBackendOptions = {
  /**
   * Base URL including the OpenAI API prefix, e.g.
   * `http://127.0.0.1:8080/v1`. Route paths (`/chat/completions`, `/models`,
   * `/embeddings`) are appended to this value.
   */
  baseUrl: string;
  /**
   * Bearer credential forwarded to the backend. Local servers ignore it; the
   * default mirrors the `not-needed` placeholder the AI SDK uses for local
   * OpenAI-compatible servers.
   */
  apiKey?: string;
  /** Model id used when a request omits `model`. */
  defaultModel?: string;
  /**
   * When set, every request's `model` is overwritten with this id before it is
   * forwarded upstream, regardless of what the client sent. Used by per-candidate
   * capture gateways that are dedicated to one routed endpoint: the driving CLI
   * (e.g. Claude Code) picks its own model label, but the router must always
   * receive the routed model id. Absent means the client's model passes through.
   */
  forceModel?: string;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
};

/** Join a base URL (which may end in `/`) with a route path. */
export function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** An OpenAI Chat Completions backend reached over HTTP. */
export class OpenAiBackend implements Backend {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #forceModel: string | undefined;
  readonly #extraHeaders: Record<string, string>;
  readonly defaultModel: string | undefined;

  constructor(options: OpenAiBackendOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey ?? "not-needed";
    this.#forceModel = options.forceModel;
    this.#extraHeaders = options.headers ?? {};
    this.defaultModel = options.defaultModel;
  }

  #headers(options: BackendRequestOptions = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      ...this.#extraHeaders,
      ...(options.modelCallId ? { "x-routekit-model-call-id": options.modelCallId } : {})
    };
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const routed =
      this.#forceModel !== undefined && typeof body === "object" && body !== null && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    const selection = reasoningSelectionOf(routed);
    if (
      (selection.mode === "budget" || selection.mode === "adaptive") &&
      options.reasoningCapabilities?.wireShape !== "openrouter"
    ) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message: `OpenAI Chat cannot represent reasoning mode "${selection.mode}"`
            }
          },
          { status: 400 }
        )
      );
    }
    const payload =
      options.reasoningCapabilities?.wireShape === "openrouter" &&
      routed !== null &&
      typeof routed === "object" &&
      !Array.isArray(routed)
        ? this.#openRouterReasoning(routed as Record<string, unknown>, selection)
        : routed;
    return fetch(joinPath(this.#baseUrl, "/chat/completions"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {})
    });
  }

  #openRouterReasoning(
    body: Record<string, unknown>,
    selection: ReturnType<typeof reasoningSelectionOf>
  ): Record<string, unknown> {
    const payload = { ...body };
    delete payload.reasoning_effort;
    if (selection.mode === "effort") {
      payload.reasoning = { effort: selection.effort };
    } else if (selection.mode === "budget") {
      payload.reasoning = { max_tokens: selection.budgetTokens };
    } else if (selection.mode === "adaptive") {
      payload.reasoning = { enabled: true };
    } else if (selection.mode === "disabled") {
      payload.reasoning = { enabled: false };
    }
    return payload;
  }

  models(signal?: AbortSignal): Promise<Response> {
    return fetch(joinPath(this.#baseUrl, "/models"), {
      method: "GET",
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(joinPath(this.#baseUrl, "/embeddings"), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  }
}

export type ModelRoutedBackendOptions = {
  /** Requested model ids served by `routed` instead of the primary backend. */
  routedModelIds: readonly string[];
  /** Backend for the routed ids. */
  routed: Backend;
  /** Backend for everything else (e.g. the member's router endpoint). */
  primary: Backend;
};

/**
 * A backend that dispatches by requested model id: ids in `routedModelIds` go
 * to the `routed` backend, everything else to `primary`. This lets selected
 * model ids use a secondary destination.
 */
export class ModelRoutedBackend implements Backend {
  readonly #routedIds: ReadonlySet<string>;
  readonly #routed: Backend;
  readonly #primary: Backend;
  readonly defaultModel: string | undefined;

  constructor(options: ModelRoutedBackendOptions) {
    this.#routedIds = new Set(options.routedModelIds);
    this.#routed = options.routed;
    this.#primary = options.primary;
    this.defaultModel = options.primary.defaultModel;
  }

  #backendFor(model: string | undefined): Backend {
    return model !== undefined && this.#routedIds.has(model) ? this.#routed : this.#primary;
  }

  listModelIds(): readonly string[] {
    const ids = [...(this.#primary.listModelIds?.() ?? (this.defaultModel !== undefined ? [this.defaultModel] : []))];
    for (const id of this.#routedIds) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  resolveModel(requested: string | undefined): string | undefined {
    if (requested !== undefined && this.#routedIds.has(requested)) return requested;
    return this.#primary.resolveModel?.(requested) ?? this.#primary.defaultModel;
  }

  chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    const model =
      typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : undefined;
    return this.#backendFor(model).chat(body, signal, options);
  }

  models(signal?: AbortSignal): Promise<Response> {
    return this.#primary.models(signal);
  }

  embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.#primary.embeddings(body, signal);
  }

  async close(): Promise<void> {
    await this.#primary.close?.();
    await this.#routed.close?.();
  }
}
