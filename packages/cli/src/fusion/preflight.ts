/**
 * Preflight: the binaries and API keys a `fusionkit <tool>` run requires, given
 * the tool, panel, and options. The actual prerequisite check lives in
 * `../shared/preflight.ts`; this computes what to check.
 */
import { toolRegistry } from "../tools.js";

import { defaultKeyEnv, providerDefaultBaseUrl } from "./env.js";
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
  // Subscription members (auth set) reuse a local CLI login, not an env key.
  if (spawnsServers) {
    for (const spec of models) {
      if (spec.auth !== undefined) continue;
      const provider = spec.provider ?? "mlx";
      if (provider === "mlx") continue;
      const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
      if (keyEnv !== undefined) requiredEnv.push(keyEnv);
    }
  }

  return { requiredBins, requiredEnv };
}

/** One key-validation probe: where to call and how to authenticate. */
type KeyProbe = { url: string; headers: Record<string, string>; invalidStatuses: number[] };

/**
 * Build the cheap "is this key accepted at all" probe for a cloud member: an
 * unauthenticated-data-free models-list call. Returns undefined for providers
 * we cannot probe generically (mlx, openai-compatible, subscription auth).
 */
function keyProbeFor(spec: PanelModelSpec, key: string): KeyProbe | undefined {
  const provider = spec.provider;
  if (spec.auth !== undefined || provider === undefined) return undefined;
  switch (provider) {
    case "openai":
      return {
        url: `${spec.baseUrl ?? providerDefaultBaseUrl(provider)}/v1/models`,
        headers: { authorization: `Bearer ${key}` },
        invalidStatuses: [401, 403]
      };
    case "anthropic":
      return {
        url: `${spec.baseUrl ?? providerDefaultBaseUrl(provider)}/v1/models`,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        invalidStatuses: [401, 403]
      };
    case "google":
      return {
        url: `${spec.baseUrl ?? providerDefaultBaseUrl(provider)}/v1beta/models`,
        headers: { "x-goog-api-key": key },
        // Google rejects a malformed key with 400 (API_KEY_INVALID).
        invalidStatuses: [400, 401, 403]
      };
    case "mlx":
    case "openai-compatible":
      return undefined;
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

/**
 * Validate the panel's provider API keys with a cheap models-list call each, so
 * a bad key fails in ~2s with the env var named instead of after the router's
 * 60s readiness timeout. Only an explicit auth rejection is a problem; network
 * errors, timeouts, and provider hiccups are ignored (never block an offline or
 * proxied run on a probe). Returns one problem line per rejected key.
 */
export async function validateProviderKeys(
  models: readonly PanelModelSpec[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<string[]> {
  const env = options.env ?? process.env;
  if (env.FUSIONKIT_SKIP_KEY_VALIDATION === "1") return [];
  const timeoutMs = options.timeoutMs ?? 4000;
  const seen = new Set<string>();
  const probes: Array<{ keyEnv: string; provider: string; probe: KeyProbe }> = [];
  for (const spec of models) {
    const provider = spec.provider ?? "mlx";
    if (provider === "mlx" || spec.auth !== undefined) continue;
    const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
    if (keyEnv === undefined || seen.has(keyEnv)) continue;
    const key = env[keyEnv];
    if (key === undefined || key.length === 0) continue;
    const probe = keyProbeFor(spec, key);
    if (probe === undefined) continue;
    seen.add(keyEnv);
    probes.push({ keyEnv, provider, probe });
  }
  const results = await Promise.all(
    probes.map(async ({ keyEnv, provider, probe }) => {
      try {
        const response = await fetch(probe.url, {
          headers: probe.headers,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (probe.invalidStatuses.includes(response.status)) {
          return `  - ${keyEnv} was rejected by ${provider} (HTTP ${response.status}) — check the key value (and that it has API access)`;
        }
      } catch {
        // Unreachable provider (offline, proxy, DNS): not a key problem.
      }
      return undefined;
    })
  );
  return results.filter((problem): problem is string => problem !== undefined);
}
