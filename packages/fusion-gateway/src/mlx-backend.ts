import { mlxServer } from "@fusionkit/adapter-ai-sdk";
import type { ManagedServerEvent } from "@fusionkit/adapter-ai-sdk";
import { chatTemplateKwargsForModel } from "@velum-labs/routekit-registry";

import { OpenAiBackend } from "@velum-labs/routekit-gateway";
import type { Backend } from "@velum-labs/routekit-gateway";

/**
 * The first-class gateway backend: the owned `velum-labs/mlx-lm` fork run as
 * `mlx_lm.server`, provisioned and supervised by `mlxServer`
 * (`@fusionkit/adapter-ai-sdk`). The gateway does not speak the AI SDK model
 * interface to it — it proxies raw HTTP to the server's OpenAI-compatible
 * `/v1` surface — so this wrapper only needs the process lifecycle and the
 * resolved base URL. A long-lived gateway keeps the server up
 * (`idleShutdownMs: 0` by default) rather than scaling to zero between calls.
 */

export type MlxBackendOptions = {
  /** Hugging Face repo id the mlx server loads. */
  model: string;
  /**
   * Provision the structured-decoding fork (`response_format`, `guided_json`,
   * …). Defaults to true: structured output is the reason we own the fork.
   */
  structured?: boolean;
  /**
   * Idle period after which the underlying server scales to zero; defaults to
   * 0 (stay up) since the gateway is a long-lived front door.
   */
  idleShutdownMs?: number;
  onEvent?: (event: ManagedServerEvent) => void;
};

/**
 * Per-model chat-template defaults from the capability registry: Qwen3-class
 * templates honor `enable_thinking` and reason before answering (measurably
 * better agentic behavior); model families without a registry entry keep their
 * template defaults. A caller that sets `chat_template_kwargs` itself always
 * wins — the narration writer explicitly sends `enable_thinking: false` and
 * must stay off. The request's own `model` field (when present) selects the
 * family; otherwise the server's configured model does.
 */
export function withThinkingDefault(body: unknown, serverModel?: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.chat_template_kwargs !== undefined) return body;
  const model = typeof record.model === "string" && record.model.length > 0
    ? record.model
    : serverModel;
  if (model === undefined) return body;
  const kwargs = chatTemplateKwargsForModel(model);
  if (kwargs === undefined) return body;
  return { ...record, chat_template_kwargs: { ...kwargs } };
}

export class MlxBackend implements Backend {
  readonly #server: ReturnType<typeof mlxServer>;
  readonly #model: string;
  #inner: OpenAiBackend | undefined;
  #startPromise: Promise<void> | undefined;

  constructor(options: MlxBackendOptions) {
    this.#model = options.model;
    this.#server = mlxServer({
      model: options.model,
      idleShutdownMs: options.idleShutdownMs ?? 0,
      structured: options.structured ?? true,
      ...(options.onEvent ? { onEvent: options.onEvent } : {})
    });
  }

  get defaultModel(): string {
    return this.#model;
  }

  /** The owned MLX footprint (verify/info/destroy). */
  get env(): ReturnType<typeof mlxServer>["env"] {
    return this.#server.env;
  }

  /** Provision (if needed), spawn, and health-check the mlx server. */
  start(): Promise<void> {
    if (!this.#startPromise) {
      this.#startPromise = (async () => {
        await this.#server.start();
        const base = this.#server.baseURL();
        if (base === undefined) {
          throw new Error("mlx server did not report a base URL after start");
        }
        // The server's base URL omits the OpenAI prefix; the fork serves the
        // OpenAI routes under /v1 (see mlx_lm.server).
        this.#inner = new OpenAiBackend({
          baseUrl: `${base}/v1`,
          defaultModel: this.#model
        });
      })().catch((error) => {
        this.#startPromise = undefined;
        throw error;
      });
    }
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    await this.#server.stop();
    this.#inner = undefined;
    this.#startPromise = undefined;
  }

  /** Backend lifecycle hook: a gateway owning this backend tears the server down. */
  async close(): Promise<void> {
    await this.stop();
  }

  async #ready(): Promise<OpenAiBackend> {
    await this.start();
    if (this.#inner === undefined) {
      throw new Error("mlx backend is not ready");
    }
    return this.#inner;
  }

  async chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).chat(withThinkingDefault(body, this.#model), signal);
  }

  async models(signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).models(signal);
  }

  async embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).embeddings(body, signal);
  }
}
