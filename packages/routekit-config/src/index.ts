import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isRecord } from "@routekit/config-core";
import { parseRouterConfig } from "@routekit/gateway";
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
        `${source}: inline credential field "${path.length > 0 ? `${path}.` : ""}${key}" is not allowed; use apiKeyEnv`
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
  if (!isRecord(parsed)) throw new Error(`${path}: router config must be a YAML object`);
  assertNoInlineCredentials(parsed, path);
  return parsed;
}

function mergeConfig(
  globalConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>
): Record<string, unknown> {
  const globalAccounts = isRecord(globalConfig.accounts) ? globalConfig.accounts : {};
  const projectAccounts = isRecord(projectConfig.accounts) ? projectConfig.accounts : {};
  const accounts = { ...globalAccounts, ...projectAccounts };
  for (const key of new Set([...Object.keys(globalAccounts), ...Object.keys(projectAccounts)])) {
    if (isRecord(globalAccounts[key]) && isRecord(projectAccounts[key])) {
      accounts[key] = { ...globalAccounts[key], ...projectAccounts[key] };
    }
  }
  return {
    ...globalConfig,
    ...projectConfig,
    ...(isRecord(globalConfig.accounts) || isRecord(projectConfig.accounts) ? { accounts } : {})
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
  assertNoInlineCredentials(config, path);
  parseRouterConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Persist only fields the caller supplied. Materializing schema defaults in
  // a project overlay would accidentally override explicit global settings.
  writeFileAtomic(path, stringifyYaml(config), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
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
  endpoints: [
    {
      endpointId: "default",
      model: "provider-model-id",
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      dialect: "openai",
      apiKeyEnv: "PROVIDER_API_KEY",
      capabilities: {
        streaming: "supported",
        tools: "supported",
        images: "unknown",
        reasoning_controls: "unknown"
      }
    }
  ],
  defaultEndpointId: "default"
});
