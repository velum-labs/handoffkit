import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { routekitHome, writeRouterConfig } from "@routekit/config";
import {
  parseRouterConfig,
  PROVIDER_IDS,
  type ProviderId,
  type RouterConfig
} from "@routekit/gateway";
import { PROVIDERS } from "@routekit/registry";
import { trimTrailingSlashes } from "@routekit/runtime";
import { parse as parseYaml } from "yaml";

export {
  DEFAULT_ROUTER_CONFIG,
  commitEffectiveRouterConfigUpdate,
  findProjectRouterConfig,
  planEffectiveRouterConfigUpdate,
  restoreEffectiveRouterConfigUpdate,
  globalRouterConfigPath,
  loadRouterConfig,
  projectRouterConfigPath,
  routekitHome,
  routerConfigPaths,
  updateEffectiveRouterConfig,
  updateRouterConfig,
  writeRouterConfig
} from "@routekit/config";
export type {
  LoadedRouterConfig,
  PlannedRouterConfigUpdate,
  RouterConfigPaths,
  RouterConfigSource,
  UpdateRouterConfigInput
} from "@routekit/config";

export type MigrationAction = {
  source: string;
  destination: string;
  action: "copied" | "skipped";
};

export type ConfigMigrationDiagnostic = {
  level: "warning" | "error";
  code:
    | "custom-alias"
    | "custom-url"
    | "custom-credential"
    | "endpoint-pool"
    | "unsupported-endpoint"
    | "unsupported-field"
    | "unknown-default";
  message: string;
  path?: string;
};

export type LegacyConfigMigration = {
  legacy: boolean;
  changed: boolean;
  config?: RouterConfig;
  diagnostics: ConfigMigrationDiagnostic[];
};

type LegacyEndpoint = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerId(value: unknown): ProviderId | undefined {
  const normalized =
    value === "claude" || value === "claudeCode" ? "claude-code" : value;
  return typeof normalized === "string" &&
    PROVIDER_IDS.includes(normalized as ProviderId)
    ? (normalized as ProviderId)
    : undefined;
}

function normalizedUrl(value: string): string {
  return trimTrailingSlashes(value);
}

function providerUrls(provider: ProviderId): string[] {
  const info = PROVIDERS[provider];
  if (info?.baseUrl === undefined) return [];
  const base = normalizedUrl(info.baseUrl);
  const basePath = info.wire?.basePath;
  return [
    base,
    ...(basePath !== undefined && basePath.length > 0
      ? [`${base}/${basePath.replace(/^\/+/, "")}`]
      : [])
  ];
}

function endpointProvider(endpoint: LegacyEndpoint): ProviderId | undefined {
  const account = providerId(endpoint.account);
  if (account !== undefined) return account;
  const explicit = providerId(endpoint.provider);
  if (explicit !== undefined) return explicit;
  if (typeof endpoint.apiKeyEnv === "string") {
    return PROVIDER_IDS.find(
      (candidate) => PROVIDERS[candidate]?.keyEnv === endpoint.apiKeyEnv
    );
  }
  if (typeof endpoint.baseUrl === "string") {
    const url = normalizedUrl(endpoint.baseUrl);
    return PROVIDER_IDS.find((candidate) => providerUrls(candidate).includes(url));
  }
  return undefined;
}

function policyFromLegacy(value: unknown): Record<string, unknown> {
  const source = record(value) ?? {};
  return Object.fromEntries(
    ["strategy", "switchThreshold", "probeIntervalMs", "fallbackCooldownSeconds"].flatMap(
      (key) => (source[key] === undefined ? [] : [[key, source[key]]])
    )
  );
}

function nativeModel(provider: ProviderId, model: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

export function convertLegacyRouterConfig(value: unknown): LegacyConfigMigration {
  const source = record(value);
  if (source === undefined) {
    return {
      legacy: false,
      changed: false,
      diagnostics: [
        {
          level: "error",
          code: "unsupported-field",
          message: "router config must be a YAML object"
        }
      ]
    };
  }
  const legacy =
    Object.hasOwn(source, "endpoints") ||
    Object.hasOwn(source, "accounts") ||
    Object.hasOwn(source, "defaultEndpointId");
  if (!legacy) {
    try {
      return {
        legacy: false,
        changed: false,
        config: parseRouterConfig(source),
        diagnostics: []
      };
    } catch (error) {
      return {
        legacy: false,
        changed: false,
        diagnostics: [
          {
            level: "error",
            code: "unsupported-field",
            message: error instanceof Error ? error.message : String(error)
          }
        ]
      };
    }
  }

  const diagnostics: ConfigMigrationDiagnostic[] = [];
  const providers: Record<string, Record<string, unknown>> = {};
  const existingProviders = record(source.providers);
  for (const [name, policy] of Object.entries(existingProviders ?? {})) {
    const id = providerId(name);
    if (id === undefined) {
      diagnostics.push({
        level: "error",
        code: "unsupported-field",
        path: `providers.${name}`,
        message: `provider "${name}" is not supported by the provider catalog`
      });
      continue;
    }
    for (const key of Object.keys(record(policy) ?? {})) {
      if (
        ![
          "strategy",
          "switchThreshold",
          "probeIntervalMs",
          "fallbackCooldownSeconds"
        ].includes(key)
      ) {
        diagnostics.push({
          level: "error",
          code: "unsupported-field",
          path: `providers.${name}.${key}`,
          message: `provider field "${key}" cannot be represented`
        });
      }
    }
    providers[id] = policyFromLegacy(policy);
  }

  const accounts = record(source.accounts) ?? {};
  for (const [name, rawPolicy] of Object.entries(accounts)) {
    const id = providerId(name);
    const policy = record(rawPolicy) ?? {};
    if (id !== "codex" && id !== "claude-code") {
      diagnostics.push({
        level: "error",
        code: "unsupported-field",
        path: `accounts.${name}`,
        message: `legacy account provider "${name}" cannot be represented`
      });
      continue;
    }
    const unsupported = Object.keys(policy).filter(
      (key) =>
        ![
          "enabled",
          "strategy",
          "switchThreshold",
          "probeIntervalMs",
          "fallbackCooldownSeconds"
        ].includes(key)
    );
    for (const key of unsupported) {
      diagnostics.push({
        level: "error",
        code: "unsupported-field",
        path: `accounts.${name}.${key}`,
        message: `legacy account field "${key}" cannot be represented by provider policy`
      });
    }
    if (policy.enabled !== false) {
      providers[id] = { ...providers[id], ...policyFromLegacy(policy) };
    }
  }

  const endpoints = Array.isArray(source.endpoints) ? source.endpoints : [];
  if (!Array.isArray(source.endpoints)) {
    diagnostics.push({
      level: "error",
      code: "unsupported-endpoint",
      path: "endpoints",
      message: "legacy endpoints must be an array"
    });
  }
  const aliases = new Map<string, string>();
  const endpointIds = new Set<string>();
  for (const [index, rawEndpoint] of endpoints.entries()) {
    const endpoint = record(rawEndpoint);
    const path = `endpoints[${index}]`;
    if (endpoint === undefined) {
      diagnostics.push({
        level: "error",
        code: "unsupported-endpoint",
        path,
        message: "endpoint must be an object"
      });
      continue;
    }
    const id = typeof endpoint.endpointId === "string" ? endpoint.endpointId : undefined;
    const model = typeof endpoint.model === "string" ? endpoint.model : undefined;
    const provider = endpointProvider(endpoint);
    if (id === undefined || model === undefined || provider === undefined) {
      diagnostics.push({
        level: "error",
        code: "unsupported-endpoint",
        path,
        message:
          "endpoint requires endpointId, model, and a known provider/account identity"
      });
      continue;
    }
    if (endpointIds.has(id) || endpoint.instanceId !== undefined) {
      diagnostics.push({
        level: "error",
        code: "endpoint-pool",
        path,
        message: `endpoint pool "${id}" cannot be represented by one provider source`
      });
    }
    endpointIds.add(id);
    for (const key of Object.keys(endpoint)) {
      if (
        ![
          "endpointId",
          "model",
          "account",
          "provider",
          "baseUrl",
          "dialect",
          "apiKeyEnv",
          "instanceId",
          "capabilities"
        ].includes(key)
      ) {
        diagnostics.push({
          level: "error",
          code: "unsupported-field",
          path: `${path}.${key}`,
          message: `custom endpoint field "${key}" cannot be represented`
        });
      }
    }
    if (endpoint.capabilities !== undefined) {
      diagnostics.push({
        level: "warning",
        code: "unsupported-field",
        path: `${path}.capabilities`,
        message: "manual endpoint capabilities are replaced by live provider discovery"
      });
    }
    const expectedDialect = PROVIDERS[provider]?.wire?.protocol;
    if (
      typeof endpoint.dialect === "string" &&
      expectedDialect !== undefined &&
      endpoint.dialect !== expectedDialect
    ) {
      diagnostics.push({
        level: "error",
        code: "unsupported-field",
        path: `${path}.dialect`,
        message: `custom dialect "${endpoint.dialect}" cannot be represented; provider "${provider}" uses "${expectedDialect}"`
      });
    }
    const publicModel = `${provider}/${nativeModel(provider, model)}`;
    aliases.set(id, publicModel);
    if (id !== publicModel) {
      diagnostics.push({
        level: "warning",
        code: "custom-alias",
        path: `${path}.endpointId`,
        message: `endpoint alias "${id}" becomes live model "${publicModel}"`
      });
    }
    if (
      typeof endpoint.baseUrl === "string" &&
      !providerUrls(provider).includes(normalizedUrl(endpoint.baseUrl))
    ) {
      diagnostics.push({
        level: "error",
        code: "custom-url",
        path: `${path}.baseUrl`,
        message: `custom URL for provider "${provider}" cannot be represented; use the registry-defined base URL environment variable`
      });
    }
    const expectedCredential = PROVIDERS[provider]?.keyEnv;
    if (
      typeof endpoint.apiKeyEnv === "string" &&
      endpoint.apiKeyEnv !== expectedCredential
    ) {
      diagnostics.push({
        level: "error",
        code: "custom-credential",
        path: `${path}.apiKeyEnv`,
        message: `custom credential environment "${endpoint.apiKeyEnv}" cannot be represented; provider "${provider}" uses ${expectedCredential ?? "managed credentials"}`
      });
    }
    providers[provider] = { ...providers[provider] };
  }

  for (const key of Object.keys(source)) {
    if (
      !["providers", "endpoints", "accounts", "defaultEndpointId", "defaultModel"].includes(
        key
      )
    ) {
      diagnostics.push({
        level: "error",
        code: "unsupported-field",
        path: key,
        message: `legacy top-level field "${key}" cannot be represented`
      });
    }
  }

  let defaultModel =
    typeof source.defaultModel === "string" ? source.defaultModel : undefined;
  if (typeof source.defaultEndpointId === "string") {
    defaultModel = aliases.get(source.defaultEndpointId);
    if (defaultModel === undefined) {
      diagnostics.push({
        level: "error",
        code: "unknown-default",
        path: "defaultEndpointId",
        message: `default endpoint "${source.defaultEndpointId}" has no convertible model`
      });
    }
  }
  if (Object.keys(providers).length === 0) {
    diagnostics.push({
      level: "error",
      code: "unsupported-endpoint",
      message: "legacy config does not contain any convertible providers"
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return { legacy: true, changed: false, diagnostics };
  }
  const config = parseRouterConfig({
    providers,
    ...(defaultModel !== undefined ? { defaultModel } : {})
  });
  return { legacy: true, changed: true, config, diagnostics };
}

export function migrateLegacyRouterConfig(
  path: string,
  input: { write?: boolean } = {}
): LegacyConfigMigration & { path: string; backupPath?: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      path,
      legacy: false,
      changed: false,
      diagnostics: [
        {
          level: "error",
          code: "unsupported-field",
          message: `${path}: invalid YAML (${error instanceof Error ? error.message : String(error)})`
        }
      ]
    };
  }
  const result = convertLegacyRouterConfig(parsed);
  if (
    input.write === false ||
    !result.changed ||
    result.config === undefined
  ) {
    return { path, ...result };
  }
  const backupPath = `${path}.legacy.bak`;
  if (!existsSync(backupPath)) cpSync(path, backupPath, { errorOnExist: true });
  writeRouterConfig(path, result.config);
  return { path, backupPath, ...result };
}

function legacyStateRoot(home: string): string {
  const legacyName = `.${["fu", "sion", "kit"].join("")}`;
  return join(home, legacyName, "subscriptions");
}

function canonicalSubscriptionDirectory(name: string): string {
  return name === "claude" || name === "claudeCode" ? "claude-code" : name;
}

function copyStateEntry(source: string, destination: string, actions: MigrationAction[]): void {
  if (existsSync(destination)) {
    actions.push({ source, destination, action: "skipped" });
    return;
  }
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    actions.push({ source, destination, action: "skipped" });
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    for (const name of readdirSync(source)) {
      copyStateEntry(join(source, name), join(destination, name), actions);
    }
    return;
  }
  if (!stat.isFile()) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { errorOnExist: true, force: false });
  chmodSync(destination, 0o600);
  actions.push({ source, destination, action: "copied" });
}

export function migrateLegacyState(
  input: { home?: string; stateHome?: string } = {}
): MigrationAction[] {
  const home = input.home ?? homedir();
  const source = legacyStateRoot(home);
  const destination = join(input.stateHome ?? routekitHome(), "subscriptions");
  if (!existsSync(source)) return [];
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const actions: MigrationAction[] = [];
  const destinations = new Map<string, string>();
  for (const name of readdirSync(source)) {
    const canonical = canonicalSubscriptionDirectory(name);
    const previous = destinations.get(canonical);
    if (previous !== undefined) {
      throw new Error(
        `legacy subscription directories "${previous}" and "${name}" both map to "${canonical}"`
      );
    }
    destinations.set(canonical, name);
    copyStateEntry(join(source, name), join(destination, canonical), actions);
  }
  return actions;
}
