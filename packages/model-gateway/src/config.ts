import { OpenAiBackend } from "./backend.js";
import type { Backend } from "./backend.js";
import { MlxBackend } from "./mlx-backend.js";

/**
 * Backend selection for the gateway. The default is the owned mlx fork
 * (`mlx_lm.server`) — "mlx_lm.server first". An explicit OpenAI-compatible URL
 * (`FUSIONKIT_LOCAL_MODEL_URL`) overrides it, which covers an already-running mlx
 * server or a different local server (Ollama, vLLM, LM Studio) on hosts where
 * the mlx provisioner cannot run. Legacy `WARRANT_*` names are still honored.
 */

/** Default mlx model, matching the examples/mlx default. */
export const DEFAULT_MLX_MODEL = "prism-ml/Ternary-Bonsai-4B-mlx-2bit";

export type BackendConfig =
  | { kind: "mlx"; model: string; structured: boolean }
  | { kind: "openai"; baseUrl: string; apiKey?: string; defaultModel?: string };

export function resolveBackendConfig(
  env: Record<string, string | undefined> = process.env
): BackendConfig {
  const url = env.FUSIONKIT_LOCAL_MODEL_URL ?? env.WARRANT_LOCAL_MODEL_URL;
  if (url !== undefined && url.length > 0) {
    const apiKey = env.FUSIONKIT_LOCAL_MODEL_KEY ?? env.WARRANT_LOCAL_MODEL_KEY;
    const defaultModel = env.FUSIONKIT_LOCAL_MODEL ?? env.WARRANT_LOCAL_MODEL;
    return {
      kind: "openai",
      baseUrl: url,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {})
    };
  }
  return {
    kind: "mlx",
    model: env.FUSIONKIT_MLX_MODEL ?? env.WARRANT_MLX_MODEL ?? DEFAULT_MLX_MODEL,
    // Structured decoding (the owned fork's reason for being) is on unless
    // explicitly disabled.
    structured: (env.FUSIONKIT_MLX_STRUCTURED ?? env.WARRANT_MLX_STRUCTURED) !== "0"
  };
}

export function createBackend(config: BackendConfig): Backend {
  switch (config.kind) {
    case "mlx":
      return new MlxBackend({ model: config.model, structured: config.structured });
    case "openai":
      return new OpenAiBackend({
        baseUrl: config.baseUrl,
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.defaultModel !== undefined ? { defaultModel: config.defaultModel } : {})
      });
    default: {
      const unreachable: never = config;
      throw new Error(`unknown backend config: ${JSON.stringify(unreachable)}`);
    }
  }
}
