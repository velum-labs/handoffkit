/**
 * Preflight: the binaries and API keys a `fusionkit <tool>` run requires, given
 * the tool, panel, and options. The actual prerequisite check lives in
 * `../shared/preflight.ts`; this computes what to check.
 */
import { toolRegistry } from "../tools.js";

import { defaultKeyEnv } from "./env.js";
import type { FusionTool, PanelModelSpec, RunFusionOptions } from "./env.js";

/** The PATH binary each coding agent launches as. `serve` launches nothing. */
export function agentBinary(tool: FusionTool): string | undefined {
  return toolRegistry.get(tool)?.binary;
}

/**
 * Compute the binaries and API keys the run requires given the tool, panel, and
 * options. Pre-running endpoints (`--model-endpoint`) and a pre-running
 * `--synthesis-url` drop the corresponding requirements.
 */
export function preflightRequirements(
  tool: FusionTool,
  models: PanelModelSpec[],
  options: RunFusionOptions
): { requiredBins: string[]; requiredEnv: string[] } {
  const requiredBins: string[] = [];
  const requiredEnv: string[] = [];

  const endpointsProvided = options.endpoints !== undefined;
  const spawnsServers = !endpointsProvided;
  const spawnsSynthesizer = options.synthesisUrl === undefined;

  // The FusionKit Python CLI is fetched via uvx (or run from a local checkout).
  if (spawnsServers || spawnsSynthesizer) {
    requiredBins.push(options.fusionkitDir !== undefined ? "uv" : "uvx");
  }

  const agent = agentBinary(tool);
  if (agent !== undefined) requiredBins.push(agent);

  // Cloud panel members need their provider key when we front them ourselves.
  if (spawnsServers) {
    for (const spec of models) {
      const provider = spec.provider ?? "mlx";
      if (provider === "mlx") continue;
      const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
      if (keyEnv !== undefined) requiredEnv.push(keyEnv);
    }
  }

  return { requiredBins, requiredEnv };
}
