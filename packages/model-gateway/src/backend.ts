/**
 * The gateway's model backend: an OpenAI-compatible Chat Completions server
 * that the gateway translates every harness dialect down to. In practice this
 * is the owned `velum-labs/mlx-lm` fork (`mlx_lm.server`), but it is equally
 * any OpenAI-compatible local server (Ollama, vLLM, LM Studio) or a process
 * fronted by `mlxServer`/`routedModel`. The backend is intentionally a thin
 * `fetch` wrapper that returns the upstream `Response` unchanged, so the chat
 * surface can stream straight through and the dialect adapters can consume the
 * same core without a second abstraction.
 */

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
   * requested id when it recognises a native passthrough model so the gateway
   * can route it to its real provider instead of fusing it.
   */
  resolveModel?(requested: string | undefined): string | undefined;
  /**
   * Whether the backend serves this exact model id itself (a fused route or a
   * registered passthrough). Unlike {@link resolveModel} — which folds unknown
   * ids into the default — this distinguishes "mine" from "unknown", so the
   * gateway can hand unknown ids to a relay (e.g. the Codex backend relay)
   * instead of silently fusing them.
   */
  servesModel?(model: string): boolean;
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
  /**
   * How many fusion panel levels are above this request. 0 / absent = a user
   * front-door request; 1 = issued by a panel member (e.g. a member's fused
   * sub-agent turn). The fusion backend uses it to stop provisioning fused
   * sub-agent access below one level of delegation.
   */
  panelDepth?: number;
  /**
   * The caller will wrap the returned stream in a dialect translator
   * (Anthropic / Responses) that emits its own keepalive. The fusion backend
   * then suppresses its chat-layer `: keepalive` comments, which the translator
   * would only drop anyway, so exactly one keepalive reaches the client.
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
   * receive the endpoint id. Absent means the client's model passes through.
   */
  forceModel?: string;
  /** Extra headers sent on every request (e.g. the panel-depth marker). */
  headers?: Record<string, string>;
};

/**
 * Header carrying the fusion panel depth of the caller: requests issued from
 * inside a panel member (e.g. a member's fused sub-agent turn) arrive at the
 * front-door gateway with depth >= 1, which stops fused sub-agent provisioning
 * from recursing (a depth-1 panel's members get no fused model access).
 */
export const PANEL_DEPTH_HEADER = "x-fusionkit-panel-depth";

/** Parse a panel-depth header value; absent/invalid means depth 0 (a user request). */
export function parsePanelDepth(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

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
      ...(options.modelCallId ? { "x-velum-model-call-id": options.modelCallId } : {})
    };
  }

  chat(
    body: unknown,
    signal?: AbortSignal,
    options: BackendRequestOptions = {}
  ): Promise<Response> {
    const payload =
      this.#forceModel !== undefined && typeof body === "object" && body !== null && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), model: this.#forceModel }
        : body;
    return fetch(joinPath(this.#baseUrl, "/chat/completions"), {
      method: "POST",
      headers: this.#headers(options),
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {})
    });
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
  /** Backend for the routed ids (e.g. the front-door fusion gateway). */
  routed: Backend;
  /** Backend for everything else (e.g. the member's router endpoint). */
  primary: Backend;
};

/**
 * A backend that dispatches by requested model id: ids in `routedModelIds` go
 * to the `routed` backend, everything else to `primary`. Used by panel-member
 * capture gateways so a member's own-model traffic keeps hitting its router
 * endpoint while its fused sub-agent traffic (`fusion-*`) reaches the
 * front-door fusion gateway.
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
