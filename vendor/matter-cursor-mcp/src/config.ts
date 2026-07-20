import { homedir } from "node:os";
import { join } from "node:path";
import { MatterConfigurationError } from "./matter/errors.js";

export const SERVER_NAME = "matter-cursor-mcp";
export const SERVER_VERSION = "1.0.0";
export const DEFAULT_API_BASE_URL = "https://api.getmatter.com/public/v1";

export const DEFAULT_RATE_LIMITS = {
  read_per_minute: 120,
  search_per_minute: 30,
  markdown_per_minute: 20,
  burst_per_second: 5
} as const;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface MatterMcpConfig {
  apiToken: string;
  apiBaseUrl: string;
  allowHttp: boolean;
  cacheDir: string;
  cacheMode: "on" | "off";
  requestTimeoutMs: number;
  maxRetries: number;
  logLevel: LogLevel;
  userAgent: string;
  configurationError: MatterConfigurationError | null;
}

export interface EnvLike {
  [key: string]: string | undefined;
}

function parseIntegerSetting(
  env: EnvLike,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
  errors: string[]
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}.`);
    return defaultValue;
  }

  return parsed;
}

function normalizeBaseUrl(raw: string, allowHttp: boolean, errors: string[]): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      const isLocalHttp =
        allowHttp &&
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");

      if (!isLocalHttp) {
        errors.push("MATTER_API_BASE_URL must use HTTPS unless MATTER_MCP_ALLOW_HTTP=true for localhost tests.");
      }
    }

    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    errors.push("MATTER_API_BASE_URL must be a valid URL.");
    return DEFAULT_API_BASE_URL;
  }
}

function parseCacheMode(raw: string | undefined, errors: string[]): "on" | "off" {
  if (raw === undefined || raw === "") {
    return "on";
  }
  if (raw === "on" || raw === "off") {
    return raw;
  }
  errors.push("MATTER_MCP_CACHE_MODE must be either 'on' or 'off'.");
  return "on";
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export function loadConfig(env: EnvLike = process.env): MatterMcpConfig {
  const errors: string[] = [];
  const apiToken = env.MATTER_API_TOKEN ?? "";
  if (!apiToken.startsWith("mat_")) {
    errors.push("MATTER_API_TOKEN is missing or malformed; create a Matter API token and set MATTER_API_TOKEN=mat_...");
  }

  const allowHttp = env.MATTER_MCP_ALLOW_HTTP === "true";
  const apiBaseUrl = normalizeBaseUrl(env.MATTER_API_BASE_URL ?? DEFAULT_API_BASE_URL, allowHttp, errors);
  const cacheDir = env.MATTER_MCP_CACHE_DIR ?? join(homedir(), ".cache", SERVER_NAME);
  const cacheMode = parseCacheMode(env.MATTER_MCP_CACHE_MODE, errors);
  const requestTimeoutMs = parseIntegerSetting(
    env,
    "MATTER_MCP_REQUEST_TIMEOUT_MS",
    20_000,
    1_000,
    120_000,
    errors
  );
  const maxRetries = parseIntegerSetting(env, "MATTER_MCP_MAX_RETRIES", 3, 0, 10, errors);
  const logLevel = parseLogLevel(env.LOG_LEVEL);

  return {
    apiToken,
    apiBaseUrl,
    allowHttp,
    cacheDir,
    cacheMode,
    requestTimeoutMs,
    maxRetries,
    logLevel,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
    configurationError: errors.length > 0 ? new MatterConfigurationError(errors.join(" ")) : null
  };
}
