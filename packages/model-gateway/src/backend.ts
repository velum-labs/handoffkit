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
  readonly defaultModel: string | undefined;

  constructor(options: OpenAiBackendOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey ?? "not-needed";
    this.#forceModel = options.forceModel;
    this.defaultModel = options.defaultModel;
  }

  #headers(options: BackendRequestOptions = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
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
