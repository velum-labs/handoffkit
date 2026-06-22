/**
 * The single place the CLI constructs the owned MLX environment, so init,
 * `fusionkit models`, and `fusionkit doctor` all share one runtime + HF cache
 * (and anything downloaded by one is usable by the others).
 *
 * The structured fork is provisioned to match what the runtime spawns at run
 * time, so onboarding never causes a re-provision on first launch. `FUSIONKIT_MLX_DIR`
 * overrides the owned directory (handy for tests and isolating environments).
 */
import { mlxServer } from "@fusionkit/adapter-ai-sdk";
import type { MlxEnv } from "@fusionkit/adapter-ai-sdk";

/** A throwaway model id used only to construct the env (model-agnostic ops). */
const PROBE_MODEL = "mlx-community/Qwen3-1.7B-4bit";

/** Build the owned MlxEnv (structured fork, optional `FUSIONKIT_MLX_DIR`). */
export function ownedMlxEnv(): MlxEnv {
  const dir = process.env.FUSIONKIT_MLX_DIR;
  return mlxServer({
    model: PROBE_MODEL,
    structured: true,
    ...(dir !== undefined && dir.length > 0 ? { env: { dir } } : {})
  }).env;
}
