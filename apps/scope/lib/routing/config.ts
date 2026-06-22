/**
 * Load FusionKit routing config from `.fusionkit/fusion.json` (mirrors
 * `loadFusionConfig` / `loadRoutingConfig` in `@fusionkit/cli`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseRoutingProviderSpec, parseScenarioRoutes, RoutingConfigError, RoutingProviderError } from "./parse";
import type { FusionRoutingConfig, RoutingProviderSpec, ScenarioRoutes } from "./types";

export const FUSION_CONFIG_DIRNAME = ".fusionkit";
export const FUSION_CONFIG_BASENAME = "fusion.json";
export const FUSION_CONFIG_FILENAME = "fusionkit.json";
export const ROUTING_OVERRIDE_BASENAME = "routing.override.json";

export class FusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigError";
  }
}

type PanelModelSpec = {
  id: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  keyEnv?: string;
};

const PANEL_TO_ROUTING: Record<string, RoutingProviderSpec["provider"]> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google-gemini",
  "openai-compatible": "openai-compatible",
  openrouter: "openrouter",
  deepseek: "deepseek",
  groq: "groq",
  "google-gemini": "google-gemini"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fusionConfigDir(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_DIRNAME);
}

function fusionConfigPath(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), FUSION_CONFIG_BASENAME);
}

function legacyFusionConfigPath(repoRoot: string): string {
  return join(repoRoot, FUSION_CONFIG_FILENAME);
}

function routingOverridePath(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), ROUTING_OVERRIDE_BASENAME);
}

function panelSpecToRoutingProvider(spec: PanelModelSpec): RoutingProviderSpec | undefined {
  const provider = spec.provider;
  if (provider === undefined || provider === "mlx") return undefined;
  const kind = PANEL_TO_ROUTING[provider];
  if (kind === undefined) return undefined;
  return {
    id: spec.id,
    provider: kind,
    ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.keyEnv !== undefined ? { keyEnv: spec.keyEnv } : {})
  };
}

function mergeRoutingProviders(
  explicit: readonly RoutingProviderSpec[],
  panel: readonly PanelModelSpec[] | undefined
): RoutingProviderSpec[] {
  const byId = new Map<string, RoutingProviderSpec>();
  for (const spec of panel ?? []) {
    const derived = panelSpecToRoutingProvider(spec);
    if (derived !== undefined) byId.set(derived.id, derived);
  }
  for (const spec of explicit) byId.set(spec.id, spec);
  return [...byId.values()];
}

function validateRouting(raw: unknown, source: string): FusionRoutingConfig {
  if (!isRecord(raw)) throw new FusionConfigError(`${source}: routing must be an object`);
  try {
    const routes = parseScenarioRoutes(isRecord(raw.routes) ? raw.routes : raw, source);
    const providerRaw = raw.providers;
    if (!Array.isArray(providerRaw) || providerRaw.length === 0) {
      throw new FusionConfigError(`${source}: routing.providers must be a non-empty array`);
    }
    const providers = providerRaw.map((entry, index) => parseRoutingProviderSpec(entry, index));
    return { routes, providers };
  } catch (error) {
    if (error instanceof RoutingConfigError || error instanceof RoutingProviderError) {
      throw new FusionConfigError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function readAndParse(path: string): { routing?: FusionRoutingConfig; panel?: PanelModelSpec[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FusionConfigError(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!isRecord(raw)) throw new FusionConfigError(`${path}: must be a JSON object`);
  const panel = Array.isArray(raw.panel)
    ? raw.panel.filter((entry): entry is PanelModelSpec => isRecord(entry) && typeof entry.id === "string")
    : undefined;
  const routing = raw.routing !== undefined ? validateRouting(raw.routing, path) : undefined;
  return { routing, panel };
}

/**
 * Resolve the repo root for routing config lookup. Prefers `SCOPE_REPO_ROOT`,
 * then walks up from `cwd` for `.fusionkit/fusion.json`.
 */
export function resolveRepoRoot(cwd = process.cwd()): string | undefined {
  const explicit = process.env.SCOPE_REPO_ROOT;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  let dir = cwd;
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(fusionConfigPath(dir)) || existsSync(legacyFusionConfigPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export type FusionConfigLoadResult = {
  repoRoot: string;
  configPath: string;
  routing: FusionRoutingConfig | undefined;
};

/**
 * Load routing config from `.fusionkit/fusion.json`, applying optional
 * `.fusionkit/routing.override.json` route merges (mirrors CLI behaviour).
 */
export function loadFusionConfig(repoRoot: string): FusionConfigLoadResult | undefined {
  const newPath = fusionConfigPath(repoRoot);
  const legacyPath = legacyFusionConfigPath(repoRoot);
  const configPath = existsSync(newPath) ? newPath : existsSync(legacyPath) ? legacyPath : undefined;
  if (configPath === undefined) return undefined;

  const parsed = readAndParse(configPath);
  if (parsed.routing === undefined) {
    const fromPanel = routingFromPanel(parsed.panel);
    return { repoRoot, configPath, routing: fromPanel };
  }

  const overridePath = routingOverridePath(repoRoot);
  if (!existsSync(overridePath)) {
    return {
      repoRoot,
      configPath,
      routing: {
        routes: parsed.routing.routes,
        providers: mergeRoutingProviders(parsed.routing.providers, parsed.panel)
      }
    };
  }

  let overrideRaw: unknown;
  try {
    overrideRaw = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (error) {
    throw new FusionConfigError(
      `${overridePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const overrideRoutes =
    overrideRaw !== null && typeof overrideRaw === "object" && !Array.isArray(overrideRaw)
      ? parseScenarioRoutes(overrideRaw, overridePath)
      : undefined;

  const routes: ScenarioRoutes = overrideRoutes ?? parsed.routing.routes;
  return {
    repoRoot,
    configPath,
    routing: {
      routes,
      providers: mergeRoutingProviders(parsed.routing.providers, parsed.panel)
    }
  };
}

function routingFromPanel(panel: readonly PanelModelSpec[] | undefined): FusionRoutingConfig | undefined {
  if (panel === undefined || panel.length === 0) return undefined;
  const primary = panel[0];
  if (primary === undefined) return undefined;
  const providers = mergeRoutingProviders([], panel);
  if (providers.length === 0) return undefined;
  return {
    routes: { default: `${primary.id},${primary.model}` },
    providers
  };
}

/** Convenience: resolve repo root and load config in one call. */
export function loadRoutingConfigFromCwd(cwd = process.cwd()): FusionConfigLoadResult | undefined {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === undefined) return undefined;
  return loadFusionConfig(repoRoot);
}
