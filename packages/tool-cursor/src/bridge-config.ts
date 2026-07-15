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
  /**
   * Every fused ensemble model id (session default first). When more than the
   * single default is registered, the bridge also receives a
   * `BRIDGE_MODELS_JSON` list so each ensemble is selectable by model name.
   */
  fusedModels?: readonly string[];
  nativeModels?: readonly string[];
};

export type CursorIdeModelsInput = {
  gatewayUrl: string;
  modelLabel: string;
  /** Every fused ensemble model id (session default first). */
  fusedModels?: readonly string[];
  nativeModels?: readonly string[];
  apiKey?: string;
  contextTokenLimit?: number;
};

type IdeModelEntry = {
  id: string;
  displayName: string;
  providerModel: string;
  baseUrl: string;
  apiKey: string;
  contextTokenLimit: number;
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
  // With multiple registered ensembles (or natives), also hand the bridge the
  // full model list so every fused id is selectable; MODEL_NAME stays the
  // session default for bridges that only read the single-model env.
  const extraModels =
    (input.fusedModels ?? []).some((id) => id !== input.modelName) ||
    (input.nativeModels ?? []).length > 0;
  return {
    ...env,
    ...(input.caCertPath !== undefined ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? input.caCertPath } : {}),
    BRIDGE_PORT: String(input.port),
    BRIDGE_ROUTE_INVENTORY: input.routeInventory === false ? "false" : "true",
    ...(extraModels
      ? {
          BRIDGE_MODELS_JSON: cursorIdeModelsJson({
            gatewayUrl: input.gatewayUrl,
            modelLabel: input.modelName,
            ...(input.fusedModels !== undefined ? { fusedModels: input.fusedModels } : {}),
            ...(input.nativeModels !== undefined ? { nativeModels: input.nativeModels } : {}),
            ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
            ...(input.contextTokenLimit !== undefined ? { contextTokenLimit: input.contextTokenLimit } : {})
          })
        }
      : {}),
    ...cursorBridgeModelEnv(input)
  };
}

export function cursorIdeEnv(input: {
  repo: string;
  gatewayUrl: string;
  modelLabel: string;
  fusedModels?: readonly string[];
  nativeModels?: readonly string[];
  apiKey?: string;
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

/** Build the `BRIDGE_MODELS_JSON` the desktop bridge seeds into Cursor's model
 *  picker: the session-default fused model first, then every other fused
 *  ensemble model, then the natives, deduped. */
export function cursorIdeModelsJson(input: CursorIdeModelsInput): string {
  const baseUrl = cursorBridgeBaseUrl(input.gatewayUrl);
  const apiKey = input.apiKey ?? DEFAULT_LOCAL_API_KEY;
  const contextTokenLimit = input.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
  const entry = (model: string): IdeModelEntry => ({
    id: model,
    displayName: model,
    providerModel: model,
    baseUrl,
    apiKey,
    contextTokenLimit
  });
  const ids = [input.modelLabel];
  for (const id of [...(input.fusedModels ?? []), ...(input.nativeModels ?? [])]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return JSON.stringify(ids.map(entry));
}
