import { normalizeApiBaseUrl, scrubBridgeEnv } from "@routekit/runtime";

const DEFAULT_CONTEXT_TOKEN_LIMIT = 128000;
const DEFAULT_LOCAL_API_KEY = "local";
const DEFAULT_UPSTREAM_BASE_URL = "https://api2.cursor.sh";

export const CURSOR_AGENT_TOOL_POLICY = "all";
export const CURSOR_AGENT_TOOL_MAX_ITERATIONS = 24;
export const CURSOR_BRIDGE_SCRUB_PREFIXES = [
  "BRIDGE_",
  "MODEL_",
  "E2E_",
  "CURSOR_UPSTREAM"
] as const;
export const CURSOR_IDE_SCRUB_PREFIXES = [...CURSOR_BRIDGE_SCRUB_PREFIXES, "CK_"] as const;

export type CursorBridgeModelEnvInput = {
  gatewayUrl: string;
  modelName: string;
  providerModel?: string;
  apiKey?: string;
  upstreamBaseUrl?: string;
  contextTokenLimit?: number;
};

export type CursorBridgeEnvInput = CursorBridgeModelEnvInput & {
  port: number;
  baseEnv?: NodeJS.ProcessEnv;
  caCertPath?: string;
  routeInventory?: boolean;
  models?: readonly string[];
};

export type CursorIdeModelsInput = {
  gatewayUrl: string;
  modelLabel: string;
  models?: readonly string[];
  apiKey?: string;
  contextTokenLimit?: number;
};

export function cursorBridgeBaseUrl(gatewayUrl: string): string {
  return normalizeApiBaseUrl(gatewayUrl);
}

export function cursorBridgeModelEnv(input: CursorBridgeModelEnvInput): Record<string, string> {
  return {
    CURSOR_UPSTREAM_BASE_URL: input.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL,
    MODEL_BASE_URL: cursorBridgeBaseUrl(input.gatewayUrl),
    MODEL_API_KEY: input.apiKey ?? DEFAULT_LOCAL_API_KEY,
    MODEL_NAME: input.modelName,
    MODEL_PROVIDER_MODEL: input.providerModel ?? input.modelName,
    MODEL_CONTEXT_TOKEN_LIMIT: String(input.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT)
  };
}

export function cursorBridgeEnv(input: CursorBridgeEnvInput): Record<string, string> {
  const env = scrubBridgeEnv(input.baseEnv ?? process.env, CURSOR_BRIDGE_SCRUB_PREFIXES);
  return {
    ...env,
    ...(input.caCertPath !== undefined
      ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? input.caCertPath }
      : {}),
    BRIDGE_PORT: String(input.port),
    BRIDGE_ROUTE_INVENTORY: input.routeInventory === false ? "false" : "true",
    ...(input.models !== undefined && input.models.length > 1
      ? {
          BRIDGE_MODELS_JSON: cursorIdeModelsJson({
            gatewayUrl: input.gatewayUrl,
            modelLabel: input.modelName,
            models: input.models,
            ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
            ...(input.contextTokenLimit !== undefined
              ? { contextTokenLimit: input.contextTokenLimit }
              : {})
          })
        }
      : {}),
    ...cursorBridgeModelEnv(input)
  };
}

export function cursorIdeEnv(input: CursorIdeModelsInput & {
  repo: string;
  caCertPath?: string;
}): Record<string, string> {
  const env = scrubBridgeEnv(process.env, CURSOR_IDE_SCRUB_PREFIXES);
  return {
    ...env,
    CK_WORKSPACE_PATH: input.repo,
    BRIDGE_MODELS_JSON: cursorIdeModelsJson(input),
    ...cursorBridgeModelEnv({
      gatewayUrl: input.gatewayUrl,
      modelName: input.modelLabel,
      providerModel: input.modelLabel,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})
    }),
    ...(input.caCertPath !== undefined
      ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? input.caCertPath }
      : {})
  };
}

export function cursorIdeModelsJson(input: CursorIdeModelsInput): string {
  const baseUrl = cursorBridgeBaseUrl(input.gatewayUrl);
  const apiKey = input.apiKey ?? DEFAULT_LOCAL_API_KEY;
  const contextTokenLimit = input.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
  const ids = [...new Set([input.modelLabel, ...(input.models ?? [])])];
  return JSON.stringify(
    ids.map((model) => ({
      id: model,
      displayName: model,
      providerModel: model,
      baseUrl,
      apiKey,
      contextTokenLimit
    }))
  );
}
