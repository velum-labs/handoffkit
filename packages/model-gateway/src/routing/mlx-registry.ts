/**
 * Singleton registry for MLX routing backends.
 *
 * MLX server startup takes 30–60s on first load; routing must reuse one
 * {@link MlxBackend} per Hugging Face model id across requests.
 */

import { MlxBackend } from "../mlx-backend.js";
import type { Backend } from "../backend.js";

const mlxBackends = new Map<string, MlxBackend>();

/** Factory used to construct MLX backends (overridable in tests). */
export type MlxBackendFactory = (model: string) => MlxBackend;

let factory: MlxBackendFactory = (model) => new MlxBackend({ model, idleShutdownMs: 0 });

/**
 * Backend wrapper that logs once before the first MLX server start.
 */
class LazyStartMlxBackend implements Backend {
  readonly #inner: MlxBackend;
  readonly #model: string;
  #warned = false;

  constructor(inner: MlxBackend, model: string) {
    this.#inner = inner;
    this.#model = model;
  }

  get defaultModel(): string | undefined {
    return this.#inner.defaultModel;
  }

  async #maybeWarn(): Promise<void> {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(
      `[fusionkit] starting local MLX server for ${this.#model} (first request may take 30-60s)`
    );
  }

  async chat(body: unknown, signal?: AbortSignal): Promise<Response> {
    await this.#maybeWarn();
    return await this.#inner.chat(body, signal);
  }

  async models(signal?: AbortSignal): Promise<Response> {
    await this.#maybeWarn();
    return await this.#inner.models(signal);
  }

  async embeddings(body: unknown, signal?: AbortSignal): Promise<Response> {
    await this.#maybeWarn();
    return await this.#inner.embeddings(body, signal);
  }

  async close(): Promise<void> {
    // Registry owns lifecycle; individual wrappers do not stop the shared server.
  }
}

/**
 * Return a shared MLX backend for `model`, creating it on first use.
 */
export function getOrCreateMlxBackend(model: string): Backend {
  let backend = mlxBackends.get(model);
  if (backend === undefined) {
    backend = factory(model);
    mlxBackends.set(model, backend);
  }
  return new LazyStartMlxBackend(backend, model);
}

/**
 * Stop and clear all registered MLX backends (gateway shutdown).
 */
export async function disposeAllMlxBackends(): Promise<void> {
  const backends = [...mlxBackends.values()];
  mlxBackends.clear();
  await Promise.all(backends.map((backend) => backend.close()));
}

/**
 * Replace the MLX backend factory (tests only).
 *
 * @internal
 */
export function setMlxBackendFactoryForTests(next: MlxBackendFactory): void {
  factory = next;
}

/**
 * Reset the MLX registry and restore the default factory (tests only).
 *
 * @internal
 */
export function resetMlxRegistryForTests(): void {
  mlxBackends.clear();
  factory = (model) => new MlxBackend({ model, idleShutdownMs: 0 });
}
