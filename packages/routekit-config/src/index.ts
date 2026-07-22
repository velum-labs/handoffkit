import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isRecord } from "@routekit/config-core";
import { normalizeRouterConfigAliases, parseRouterConfig } from "@routekit/gateway";
import type { RouterConfig } from "@routekit/gateway";
import { writeFileAtomic } from "@routekit/runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type RouterConfigSource = "flag" | "environment" | "project" | "global";

export type LoadedRouterConfig = {
  config: RouterConfig;
  path: string;
  sources: RouterConfigSource[];
};

export type RouterConfigPaths = {
  project?: string;
  global: string;
  override?: string;
};

export type UpdateRouterConfigInput = {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
};

/** Explicit provider ids in schema declaration order. */
export function configuredProviderIds(config: RouterConfig): string[] {
  return Object.keys(config.providers);
}

/** Required namespaced model ids absent from a live catalog. */
export function missingModelIds(
  required: Iterable<string>,
  availableModels: Iterable<string>
): string[] {
  const available = new Set(availableModels);
  return [...new Set(required)].filter((model) => !available.has(model));
}

/** Reject when any required namespaced model id is absent from a live catalog. */
export function assertModelsAvailable(
  required: Iterable<string>,
  availableModels: Iterable<string>,
  message = "missing models"
): void {
  const missing = missingModelIds(required, availableModels);
  if (missing.length > 0) throw new Error(`${message}: ${missing.join(", ")}`);
}

/** Resolve an explicit model, or the configured default/first live model. */
export function resolveModelId(
  config: RouterConfig,
  availableModels: Iterable<string>,
  requested?: string
): string {
  const available = [...new Set(availableModels)];
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new Error(
        `unknown model "${requested}" (available: ${available.join(", ")})`
      );
    }
    return requested;
  }
  const selected = config.defaultModel ?? available[0];
  if (selected === undefined) throw new Error("router catalog has no models");
  assertModelsAvailable(
    [selected],
    available,
    "router config default model is not available"
  );
  return selected;
}

/** Alias retained for callers that describe model resolution as selection. */
export const selectModelId = resolveModelId;

export function routekitHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ROUTEKIT_HOME;
  return override !== undefined && override.length > 0
    ? resolve(override)
    : join(homedir(), ".routekit");
}

export function globalRouterConfigPath(home: string = homedir()): string {
  return join(home, ".config", "routekit", "router.yaml");
}

export function projectRouterConfigPath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".routekit", "router.yaml");
}

export function findProjectRouterConfig(cwd: string = process.cwd()): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = projectRouterConfigPath(directory);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function routerConfigPaths(
  input: {
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    configPath?: string;
  } = {}
): RouterConfigPaths {
  const env = input.env ?? process.env;
  const flag = input.configPath;
  const environment = env.ROUTEKIT_CONFIG;
  const project = findProjectRouterConfig(input.cwd);
  return {
    global: globalRouterConfigPath(input.home),
    ...(project !== undefined ? { project } : {}),
    ...(flag !== undefined && flag.length > 0
      ? { override: resolve(flag) }
      : environment !== undefined && environment.length > 0
        ? { override: resolve(environment) }
        : {})
  };
}

function assertNoInlineCredentials(value: unknown, source: string, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoInlineCredentials(entry, source, `${path}[${index}]`)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const lowered = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    if (
      lowered === "apikey" ||
      lowered === "token" ||
      lowered === "authorization" ||
      lowered === "xapikey" ||
      lowered === "xgoogapikey" ||
      lowered === "accesstoken" ||
      lowered === "refreshtoken" ||
      lowered === "clientsecret"
    ) {
      throw new Error(
        `${source}: inline credential field "${path.length > 0 ? `${path}.` : ""}${key}" is not allowed; use the provider registry's environment variable`
      );
    }
    assertNoInlineCredentials(child, source, path.length > 0 ? `${path}.${key}` : key);
  }
}

function readYamlObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const normalized = normalizeRouterConfigAliases(parsed);
  if (!isRecord(normalized)) throw new Error(`${path}: router config must be a YAML object`);
  assertNoInlineCredentials(normalized, path);
  return normalized;
}

/** Parse and validate an in-memory router YAML document without writing it. */
export function parseRouterConfigDocument(
  document: string,
  source = "router config"
): RouterConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(document);
  } catch (error) {
    throw new Error(
      `${source}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const normalized = normalizeRouterConfigAliases(parsed);
  if (!isRecord(normalized)) throw new Error(`${source}: router config must be a YAML object`);
  assertNoInlineCredentials(normalized, source);
  return parseRouterConfig(normalized);
}

function mergeConfig(
  globalConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>
): Record<string, unknown> {
  const globalProviders = isRecord(globalConfig.providers) ? globalConfig.providers : {};
  const projectProviders = isRecord(projectConfig.providers) ? projectConfig.providers : {};
  const providers = { ...globalProviders, ...projectProviders };
  for (const key of new Set([...Object.keys(globalProviders), ...Object.keys(projectProviders)])) {
    if (isRecord(globalProviders[key]) && isRecord(projectProviders[key])) {
      providers[key] = { ...globalProviders[key], ...projectProviders[key] };
    }
  }
  return {
    ...globalConfig,
    ...projectConfig,
    ...(isRecord(globalConfig.providers) || isRecord(projectConfig.providers)
      ? { providers }
      : {})
  };
}

export function loadRouterConfig(
  input: {
    cwd?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    configPath?: string;
  } = {}
): LoadedRouterConfig {
  const paths = routerConfigPaths(input);
  if (paths.override !== undefined) {
    if (!existsSync(paths.override)) throw new Error(`router config not found: ${paths.override}`);
    return {
      config: parseRouterConfig(readYamlObject(paths.override)),
      path: paths.override,
      sources: [input.configPath !== undefined ? "flag" : "environment"]
    };
  }
  const hasGlobal = existsSync(paths.global);
  const hasProject = paths.project !== undefined;
  if (!hasGlobal && !hasProject) {
    throw new Error("no router config found; run `routekit config init` or set ROUTEKIT_CONFIG");
  }
  const globalConfig = hasGlobal ? readYamlObject(paths.global) : {};
  const projectConfig = hasProject ? readYamlObject(paths.project as string) : {};
  return {
    config: parseRouterConfig(mergeConfig(globalConfig, projectConfig)),
    path: paths.project ?? paths.global,
    sources: [
      ...(hasProject ? (["project"] as const) : []),
      ...(hasGlobal ? (["global"] as const) : [])
    ]
  };
}

export function writeRouterConfig(path: string, config: RouterConfig | unknown): string {
  const normalized = normalizeRouterConfigAliases(config);
  assertNoInlineCredentials(normalized, path);
  parseRouterConfig(normalized);
  return writeRouterConfigDocument(path, normalized);
}

function writeRouterConfigDocument(path: string, config: unknown): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, stringifyYaml(config), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Mutate only the selected raw config layer while validating the merged result.
 *
 * This keeps project overlays sparse instead of materializing defaults or
 * inherited global values into the project file.
 */
export function updateEffectiveRouterConfig(
  input: UpdateRouterConfigInput,
  mutate: (draft: Record<string, unknown>) => void
): LoadedRouterConfig {
  const paths = routerConfigPaths(input);
  const override = paths.override;
  if (override !== undefined) {
    if (!existsSync(override)) throw new Error(`router config not found: ${override}`);
    const draft = structuredClone(readYamlObject(override));
    mutate(draft);
    assertNoInlineCredentials(draft, override);
    const config = parseRouterConfig(draft);
    writeRouterConfigDocument(override, draft);
    return {
      config,
      path: override,
      sources: [input.configPath !== undefined ? "flag" : "environment"]
    };
  }

  const hasGlobal = existsSync(paths.global);
  const projectPath = paths.project;
  if (!hasGlobal && projectPath === undefined) {
    throw new Error("no router config found; run `routekit config init` or set ROUTEKIT_CONFIG");
  }
  const target = projectPath ?? paths.global;
  const draft = structuredClone(readYamlObject(target));
  mutate(draft);
  assertNoInlineCredentials(draft, target);
  const globalConfig = hasGlobal ? readYamlObject(paths.global) : {};
  const effective =
    projectPath !== undefined ? mergeConfig(globalConfig, draft) : draft;
  const config = parseRouterConfig(effective);
  writeRouterConfigDocument(target, draft);
  return {
    config,
    path: target,
    sources: [
      ...(projectPath !== undefined ? (["project"] as const) : []),
      ...(hasGlobal ? (["global"] as const) : [])
    ]
  };
}

export function updateRouterConfig(
  path: string,
  mutate: (draft: Record<string, unknown>) => void
): RouterConfig {
  const current = existsSync(path) ? readYamlObject(path) : {};
  const draft = structuredClone(current);
  mutate(draft);
  const validated = parseRouterConfig(draft);
  writeRouterConfig(path, draft);
  return validated;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = parseRouterConfig({
  providers: {
    openai: {}
  },
  defaultModel: "openai/gpt-5.5"
});
