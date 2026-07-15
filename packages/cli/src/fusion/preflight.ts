/**
 * Preflight: the binaries and API keys a `fusionkit <tool>` run requires, given
 * the tool, panel, and options. The actual prerequisite check lives in
 * `../shared/preflight.ts`; this computes what to check.
 */
import { cliproxyBaseUrl } from "@routekit/accounts";
import { probeEndpointHealth } from "@routekit/gateway";
import type { ModelEndpointConfig } from "@routekit/gateway";

import { toolRegistry } from "../tools.js";

import { defaultKeyEnv, providerDefaultBaseUrl } from "./env.js";
import type {
  FusionTool,
  PanelModelSpec,
  PanelProvider,
  RunFusionOptions
} from "./env.js";
import { catalogEntry, detectHost, usableRamGB } from "./local-catalog.js";
import type { HostInfo } from "./local-catalog.js";
import { estimateModelSizing } from "./model-sizing.js";
import type { EstimateOptions } from "./model-sizing.js";

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

/**
 * Boot-time memory check for the local (MLX) members of a panel: every local
 * member runs as its own resident server, so what matters is their *combined*
 * footprint against the host's usable budget. Returns a one-line warning when
 * the panel likely exceeds it (models get OOM-killed mid-run by macOS memory
 * pressure — the user's tool only sees a bare stream disconnect), or undefined
 * when it fits or cannot be verified (offline / unknown repos never block).
 */
export async function localPanelMemoryWarning(
  models: readonly PanelModelSpec[],
  options: {
    /** Extra local model outside the panel (e.g. --reasoning-model). */
    extraModels?: readonly string[];
    host?: HostInfo;
    sizing?: EstimateOptions;
  } = {}
): Promise<string | undefined> {
  const repos = [
    ...models.filter((spec) => (spec.provider ?? "mlx") === "mlx").map((spec) => spec.model),
    ...(options.extraModels ?? [])
  ];
  if (repos.length === 0) return undefined;

  const sizings = await Promise.all(
    repos.map(async (repo) => {
      const fallback = catalogEntry(repo)?.minRamGB;
      const sizing = await estimateModelSizing(repo, {
        ...(fallback !== undefined ? { catalogFallbackGB: fallback } : {}),
        ...options.sizing
      });
      return { repo, sizing };
    })
  );

  // Only sum members we could actually size; an unknown repo means "can't
  // verify — don't block", not "assume zero and warn anyway".
  const sized = sizings.filter(({ sizing }) => sizing.source !== "unknown");
  if (sized.length === 0) return undefined;
  const requiredGB = sized.reduce((sum, { sizing }) => sum + sizing.requiredGB, 0);
  const host = options.host ?? detectHost();
  const budgetGB = usableRamGB(host);
  if (requiredGB <= budgetGB) return undefined;

  const breakdown = sized
    .map(({ repo, sizing }) => `${repo} ~${sizing.requiredGB.toFixed(1)}GB`)
    .join(", ");
  return (
    `the local panel needs ~${requiredGB.toFixed(1)}GB (${breakdown}) but only ` +
    `~${budgetGB.toFixed(1)}GB of this machine's ${host.totalRamGB.toFixed(0)}GB is usable — ` +
    `models may be killed mid-run by memory pressure. Prefer smaller models or quants (see \`fusionkit models\`).`
  );
}

function probeDialect(
  provider: Exclude<PanelProvider, "mlx">
): ModelEndpointConfig["dialect"] {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "openai":
    case "openrouter":
    case "cliproxy":
    case "openai-compatible":
      return "openai";
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown panel provider ${String(exhaustive)}`);
    }
  }
}

/**
 * Describe a cloud member for RouteKit's canonical provider-native health
 * probe. Subscription and local members have no environment key to validate.
 */
function keyProbeEndpoint(spec: PanelModelSpec): ModelEndpointConfig | undefined {
  const provider = spec.provider;
  if (spec.auth !== undefined || provider === undefined || provider === "mlx") return undefined;
  const base =
    spec.baseUrl ?? (provider === "cliproxy" ? cliproxyBaseUrl() : providerDefaultBaseUrl(provider));
  return {
    endpointId: spec.id,
    model: spec.model,
    provider,
    baseUrl: base,
    dialect: probeDialect(provider)
  };
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
  const probes: Array<{
    keyEnv: string;
    provider: string;
    endpoint: ModelEndpointConfig;
    credential: string;
  }> = [];
  for (const spec of models) {
    const provider = spec.provider ?? "mlx";
    if (provider === "mlx" || spec.auth !== undefined) continue;
    const keyEnv = spec.keyEnv ?? defaultKeyEnv(provider);
    if (keyEnv === undefined || seen.has(keyEnv)) continue;
    const key = env[keyEnv];
    if (key === undefined || key.length === 0) continue;
    const endpoint = keyProbeEndpoint(spec);
    if (endpoint === undefined) continue;
    seen.add(keyEnv);
    probes.push({ keyEnv, provider, endpoint, credential: key });
  }
  const results = await Promise.all(
    probes.map(async ({ keyEnv, provider, endpoint, credential }) => {
      const result = await probeEndpointHealth(endpoint, { credential, timeoutMs });
      if (result.kind === "response" && result.authRejected) {
        return `  - ${keyEnv} was rejected by ${provider} (HTTP ${result.status}) — check the key value (and that it has API access)`;
      }
      // Unsupported or unreachable providers are not key problems.
      return undefined;
    })
  );
  return results.filter((problem): problem is string => problem !== undefined);
}
