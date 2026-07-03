/**
 * Preflight: the binaries and API keys a `fusionkit <tool>` run requires, given
 * the tool, panel, and options. The actual prerequisite check lives in
 * `../shared/preflight.ts`; this computes what to check.
 */
import { providerKeyProbe } from "@fusionkit/registry";

import { toolRegistry } from "../tools.js";

import { defaultKeyEnv, providerDefaultBaseUrl } from "./env.js";
import type { FusionTool, PanelModelSpec, RunFusionOptions } from "./env.js";
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

/** One key-validation probe: where to call and how to authenticate. */
type KeyProbe = { url: string; headers: Record<string, string>; invalidStatuses: number[] };

/**
 * Build the cheap "is this key accepted at all" probe for a cloud member from
 * the provider registry's keyProbe metadata (e.g. OpenRouter's /v1/models is
 * public, so its probe targets the key-info endpoint; Google rejects a
 * malformed key with 400 API_KEY_INVALID). Returns undefined for providers
 * without probe metadata (mlx, openai-compatible, subscription auth).
 */
function keyProbeFor(spec: PanelModelSpec, key: string): KeyProbe | undefined {
  const provider = spec.provider;
  if (spec.auth !== undefined || provider === undefined || provider === "mlx") return undefined;
  const probe = providerKeyProbe(provider);
  if (probe === undefined) return undefined;
  const headers: Record<string, string> = { ...probe.extraHeaders };
  switch (probe.auth) {
    case "bearer":
      headers.authorization = `Bearer ${key}`;
      break;
    case "x-api-key":
      headers["x-api-key"] = key;
      break;
    case "x-goog-api-key":
      headers["x-goog-api-key"] = key;
      break;
    case "query-key":
      break;
    default: {
      const exhaustive: never = probe.auth;
      throw new Error(`unknown probe auth style ${String(exhaustive)}`);
    }
  }
  const base = spec.baseUrl ?? providerDefaultBaseUrl(provider);
  const url =
    probe.auth === "query-key"
      ? `${base}${probe.path}?key=${encodeURIComponent(key)}`
      : `${base}${probe.path}`;
  return { url, headers, invalidStatuses: [...probe.invalidStatuses] };
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
