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
   * Model id sent on `/v1/embeddings` when a request omits one. The mlx fork's
   * embeddings endpoint accepts only its configured embedding model id or the
   * literal `"default_model"`, so this must never be the chat model id.
   */
  readonly embeddingModel?: string | undefined;
  /** POST <base>/chat/completions — supports streaming (SSE) upstream. */
  chat(body: unknown, signal?: AbortSignal): Promise<Response>;
  /** GET <base>/models. */
  models(signal?: AbortSignal): Promise<Response>;
  /** POST <base>/embeddings. */
  embeddings(body: unknown, signal?: AbortSignal): Promise<Response>;
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
  /** Embedding model id used when an embeddings request omits `model`. */
  embeddingModel?: string;
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
  readonly defaultModel: string | undefined;
  readonly embeddingModel: string | undefined;

  constructor(options: OpenAiBackendOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey ?? "not-needed";
    this.defaultModel = options.defaultModel;
    this.embeddingModel = options.embeddingModel;
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`
    };
  }

  chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(joinPath(this.#baseUrl, "/chat/completions"), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
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
