import { mlxServer } from "@warrant/adapter-ai-sdk";
import type { ManagedServerEvent } from "@warrant/adapter-ai-sdk";

import { OpenAiBackend } from "./backend.js";
import type { Backend } from "./backend.js";

/**
 * The first-class gateway backend: the owned `velum-labs/mlx-lm` fork run as
 * `mlx_lm.server`, provisioned and supervised by `mlxServer`
 * (`@warrant/adapter-ai-sdk`). The gateway does not speak the AI SDK model
 * interface to it — it proxies raw HTTP to the server's OpenAI-compatible
 * `/v1` surface — so this wrapper only needs the process lifecycle and the
 * resolved base URL. A long-lived gateway keeps the server up
 * (`idleShutdownMs: 0` by default) rather than scaling to zero between calls.
 */

export type MlxBackendOptions = {
  /** Hugging Face repo id the mlx server loads. */
  model: string;
  /**
   * Optional embedding model id. When set, the server is started with
   * `--embedding-model <id>`, enabling `/v1/embeddings`; the gateway sends this
   * id (the fork's embeddings endpoint rejects the chat model id).
   */
  embeddingModel?: string;
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

export class MlxBackend implements Backend {
  readonly #server: ReturnType<typeof mlxServer>;
  readonly #model: string;
  readonly #embeddingModel: string | undefined;
  #inner: OpenAiBackend | undefined;
  #startPromise: Promise<void> | undefined;

  constructor(options: MlxBackendOptions) {
    this.#model = options.model;
    this.#embeddingModel = options.embeddingModel;
    this.#server = mlxServer({
      model: options.model,
      idleShutdownMs: options.idleShutdownMs ?? 0,
      structured: options.structured ?? true,
      ...(options.embeddingModel !== undefined
        ? { extraArgs: ["--embedding-model", options.embeddingModel] }
        : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {})
    });
  }

  get defaultModel(): string {
    return this.#model;
  }

  get embeddingModel(): string | undefined {
    return this.#embeddingModel;
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
          defaultModel: this.#model,
          ...(this.#embeddingModel !== undefined ? { embeddingModel: this.#embeddingModel } : {})
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

  async #ready(): Promise<OpenAiBackend> {
    await this.start();
    if (this.#inner === undefined) {
      throw new Error("mlx backend is not ready");
    }
    return this.#inner;
  }

  async chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).chat(body, signal);
  }

  async models(signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).models(signal);
  }

  async embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    return (await this.#ready()).embeddings(body, signal);
  }
}
