import {
  providerDefaultBaseUrl,
  subscriptionInfo,
  type SubscriptionMode
} from "@routekit/registry";
import { parseRetryAfterSeconds } from "@routekit/contracts";

import {
  loadSubscriptionCredential,
  persistSubscriptionCredential
} from "./credentials.js";
import type {
  AccountLimits,
  CreditSnapshot,
  RateLimitWindow,
  SubscriptionCredential,
  SubscriptionFailure
} from "./types.js";

export type AdminUsageRange = {
  startTime: number;
  endTime?: number;
};

export type AdminUsageCost = {
  usage: unknown;
  cost: unknown;
};

export type SubscriptionProvider = {
  readonly mode: SubscriptionMode;
  readonly upstreamBaseUrl: string;
  readonly requestPath: string;
  loadCredential(path: string): Promise<SubscriptionCredential>;
  authHeaders(credential: SubscriptionCredential): Record<string, string>;
  refresh(credential: SubscriptionCredential, signal?: AbortSignal): Promise<SubscriptionCredential>;
  fetchUsage(credential: SubscriptionCredential, signal?: AbortSignal): Promise<AccountLimits>;
  parseLimits(headers: Headers, body?: unknown): AccountLimits | undefined;
  parseStreamEvent(payload: unknown): AccountLimits | undefined;
  classify(status: number, headers: Headers, body: unknown): SubscriptionFailure | undefined;
  fetchAdminUsageCost(
    adminKey: string,
    range: AdminUsageRange,
    signal?: AbortSignal
  ): Promise<AdminUsageCost>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function epochSeconds(value: unknown): number | undefined {
  const direct = numeric(value);
  if (direct !== undefined) return direct;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

function utilization(value: unknown): number | undefined {
  const parsed = numeric(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function defineWindow(
  windows: Record<string, RateLimitWindow>,
  key: string,
  window: RateLimitWindow
): void {
  Object.defineProperty(windows, key, {
    value: window,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function retryAfter(headers: Headers, mode: SubscriptionMode): number | undefined {
  return parseRetryAfterSeconds(
    headers.get(subscriptionInfo(mode).rateLimit.retryAfterHeader)
  );
}

function errorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const error = body.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof body.message === "string") return body.message;
  return fallback;
}

function refreshPayload(body: unknown): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
} {
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new Error("OAuth refresh returned no access_token");
  }
  const expiresIn = numeric(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() / 1000 + expiresIn } : {})
  };
}

function windowsFromUsagePayload(payload: unknown): Record<string, RateLimitWindow> {
  if (!isRecord(payload)) return {};
  const windows = Object.create(null) as Record<string, RateLimitWindow>;
  for (const [key, raw] of Object.entries(payload)) {
    if (!isRecord(raw)) continue;
    const used = utilization(raw.utilization ?? raw.used_percent);
    if (used === undefined) continue;
    const resetsAt = epochSeconds(raw.resets_at ?? raw.reset_at);
    const windowSeconds = numeric(raw.limit_window_seconds);
    defineWindow(windows, key, {
      utilization: used,
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {})
    });
  }
  return windows;
}

function anthropicLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
  const prefix = subscriptionInfo("claude-code").rateLimit.headerPrefix.toLowerCase();
  const windows = Object.create(null) as Record<string, RateLimitWindow>;
  const suffixes = new Set<string>();
  for (const [name] of headers) {
    const lowered = name.toLowerCase();
    const match = new RegExp(`^${prefix}-(.+)-(utilization|status|reset)$`).exec(lowered);
    if (match?.[1] !== undefined) suffixes.add(match[1]);
  }
  for (const key of suffixes) {
    const used = utilization(headers.get(`${prefix}-${key}-utilization`));
    if (used === undefined) continue;
    const status = headers.get(`${prefix}-${key}-status`);
    const resetsAt = epochSeconds(headers.get(`${prefix}-${key}-reset`));
    defineWindow(windows, key, {
      utilization: used,
      ...(status !== null ? { status } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {})
    });
  }
  return Object.keys(windows).length > 0
    ? { windows, observedAt: Date.now() / 1000, source: "headers" }
    : undefined;
}

function codexWindowFromHeaders(headers: Headers, prefix: string, name: string): RateLimitWindow | undefined {
  const used = utilization(headers.get(`${prefix}-${name}-used-percent`));
  if (used === undefined) return undefined;
  const minutes = numeric(headers.get(`${prefix}-${name}-window-minutes`));
  const resetsAt = epochSeconds(headers.get(`${prefix}-${name}-reset-at`));
  const limitName = headers.get(`${prefix}-limit-name`);
  return {
    utilization: used,
    ...(minutes !== undefined ? { windowSeconds: minutes * 60 } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(limitName !== null ? { limitName } : {})
  };
}

function codexCredits(headers: Headers): CreditSnapshot | undefined {
  const hasCredits = booleanValue(headers.get("x-codex-credits-has-credits"));
  const unlimited = booleanValue(headers.get("x-codex-credits-unlimited"));
  const balance = headers.get("x-codex-credits-balance");
  if (hasCredits === undefined && unlimited === undefined && balance === null) return undefined;
  return {
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
    ...(balance !== null ? { balance } : {})
  };
}

function codexLimitsFromHeaders(headers: Headers): AccountLimits | undefined {
  const info = subscriptionInfo("codex").rateLimit;
  const active = info.activeLimitHeader === undefined ? null : headers.get(info.activeLimitHeader);
  const prefix = active === null || active.trim().length === 0
    ? info.headerPrefix
    : `x-${active.toLowerCase().replaceAll("_", "-")}`;
  const primary = codexWindowFromHeaders(headers, prefix, "primary");
  const secondary = codexWindowFromHeaders(headers, prefix, "secondary");
  const credits = codexCredits(headers);
  if (primary === undefined && secondary === undefined && credits === undefined) return undefined;
  return {
    windows: {
      ...(primary !== undefined ? { [`${active ?? "codex"}:primary`]: primary } : {}),
      ...(secondary !== undefined ? { [`${active ?? "codex"}:secondary`]: secondary } : {})
    },
    ...(credits !== undefined ? { credits } : {}),
    observedAt: Date.now() / 1000,
    source: "headers"
  };
}

function codexUsageLimits(payload: unknown): AccountLimits {
  if (!isRecord(payload)) throw new Error("Codex usage endpoint returned an invalid payload");
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const windows = windowsFromUsagePayload({
    primary: rateLimit.primary_window,
    secondary: rateLimit.secondary_window
  });
  const rawCredits = isRecord(payload.credits) ? payload.credits : undefined;
  const credits = rawCredits === undefined
    ? undefined
    : {
        ...(booleanValue(rawCredits.has_credits) !== undefined
          ? { hasCredits: booleanValue(rawCredits.has_credits) }
          : {}),
        ...(booleanValue(rawCredits.unlimited) !== undefined
          ? { unlimited: booleanValue(rawCredits.unlimited) }
          : {}),
        ...(typeof rawCredits.balance === "string" ? { balance: rawCredits.balance } : {})
      };
  return {
    windows,
    ...(typeof payload.plan_type === "string" ? { planType: payload.plan_type } : {}),
    ...(credits !== undefined ? { credits } : {}),
    observedAt: Date.now() / 1000,
    source: "usage"
  };
}

function rateLimitsObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.rate_limits)) return value.rate_limits;
  for (const child of Object.values(value)) {
    const found = rateLimitsObject(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function codexStreamLimits(payload: unknown): AccountLimits | undefined {
  const raw = rateLimitsObject(payload);
  if (raw === undefined) return undefined;
  const windows = windowsFromUsagePayload(raw);
  return Object.keys(windows).length > 0
    ? { windows, observedAt: Date.now() / 1000, source: "stream" }
    : undefined;
}

async function usageRequest(
  endpoint: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", ...headers },
    ...(signal !== undefined ? { signal } : {})
  });
  if (!response.ok) throw new Error(`subscription usage endpoint returned ${response.status}`);
  return response.json();
}

async function adminRequest(
  endpoint: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(`${endpoint}?${query.toString()}`, {
    headers: { accept: "application/json", ...headers },
    ...(signal !== undefined ? { signal } : {})
  });
  if (!response.ok) throw new Error(`Admin usage endpoint returned ${response.status}`);
  return response.json();
}

function anthropicProvider(): SubscriptionProvider {
  const mode = "claude-code" as const;
  const info = subscriptionInfo(mode);
  return {
    mode,
    upstreamBaseUrl: providerDefaultBaseUrl("anthropic") ?? "https://api.anthropic.com",
    requestPath: "/v1/messages",
    loadCredential: (path) => loadSubscriptionCredential(mode, path),
    authHeaders: (credential) => ({
      authorization: `Bearer ${credential.accessToken}`,
      "anthropic-beta": info.oauthBetaHeader ?? "oauth-2025-04-20"
    }),
    refresh: async (credential, signal) => {
      if (credential.refreshToken === undefined) throw new Error("Claude pool member has no refresh token");
      const response = await fetch(info.oauth.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: info.oauth.clientId
        }),
        ...(signal !== undefined ? { signal } : {})
      });
      if (!response.ok) throw new Error(`Claude OAuth refresh returned ${response.status}`);
      return persistSubscriptionCredential(credential, refreshPayload(await response.json()));
    },
    fetchUsage: async (credential, signal) => {
      const payload = await usageRequest(info.oauth.usageEndpoint, {
        ...thisAnthropicHeaders(info, credential)
      }, signal);
      return {
        windows: windowsFromUsagePayload(payload),
        observedAt: Date.now() / 1000,
        source: "usage"
      };
    },
    parseLimits: (headers) => anthropicLimitsFromHeaders(headers),
    parseStreamEvent: () => undefined,
    classify: (status, headers, body) => {
      if (status !== 429 && status < 500) return undefined;
      const limits = anthropicLimitsFromHeaders(headers);
      const rejected = Object.values(limits?.windows ?? {}).some((window) =>
        ["rejected", "exceeded"].includes(window.status?.toLowerCase() ?? "")
      );
      const message = errorMessage(body, `Anthropic returned ${status}`);
      const quota = rejected || /(?:usage|weekly|five.?hour).*(?:limit|quota)|limit reached/i.test(message);
      const retryAfterSeconds = retryAfter(headers, mode);
      const resetsAt = Math.min(
        ...Object.values(limits?.windows ?? {})
          .map((window) => window.resetsAt)
          .filter((value): value is number => value !== undefined)
      );
      return {
        category: quota ? "quota_exhausted" : "transient",
        message,
        ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
      };
    },
    fetchAdminUsageCost: async (adminKey, range, signal) => {
      const query = new URLSearchParams({
        starting_at: new Date(range.startTime * 1000).toISOString(),
        bucket_width: "1d"
      });
      if (range.endTime !== undefined) {
        query.set("ending_at", new Date(range.endTime * 1000).toISOString());
      }
      const headers = {
        "x-api-key": adminKey,
        "anthropic-version": "2023-06-01"
      };
      const [usage, cost] = await Promise.all([
        adminRequest(info.admin.usageEndpoint, query, headers, signal),
        adminRequest(info.admin.costEndpoint, query, headers, signal)
      ]);
      return { usage, cost };
    }
  };
}

function thisAnthropicHeaders(
  info: ReturnType<typeof subscriptionInfo>,
  credential: SubscriptionCredential
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    "anthropic-beta": info.oauthBetaHeader ?? "oauth-2025-04-20"
  };
}

function codexProvider(): SubscriptionProvider {
  const mode = "codex" as const;
  const info = subscriptionInfo(mode);
  return {
    mode,
    upstreamBaseUrl: providerDefaultBaseUrl("codex") ?? "https://chatgpt.com/backend-api/codex",
    requestPath: "/responses",
    loadCredential: (path) => loadSubscriptionCredential(mode, path),
    authHeaders: (credential) => ({
      authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId !== undefined ? { "chatgpt-account-id": credential.accountId } : {}),
      ...(info.defaultHeaders ?? {})
    }),
    refresh: async (credential, signal) => {
      if (credential.refreshToken === undefined) throw new Error("Codex pool member has no refresh token");
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: info.oauth.clientId
      });
      const response = await fetch(info.oauth.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        ...(signal !== undefined ? { signal } : {})
      });
      if (!response.ok) throw new Error(`Codex OAuth refresh returned ${response.status}`);
      return persistSubscriptionCredential(credential, refreshPayload(await response.json()));
    },
    fetchUsage: async (credential, signal) => {
      const payload = await usageRequest(info.oauth.usageEndpoint, {
        authorization: `Bearer ${credential.accessToken}`,
        ...(credential.accountId !== undefined ? { "chatgpt-account-id": credential.accountId } : {})
      }, signal);
      return codexUsageLimits(payload);
    },
    parseLimits: (headers, body) => {
      const fromHeaders = codexLimitsFromHeaders(headers);
      if (fromHeaders !== undefined) return fromHeaders;
      if (isRecord(body) && isRecord(body.rate_limit)) return codexUsageLimits(body);
      return undefined;
    },
    parseStreamEvent: codexStreamLimits,
    classify: (status, headers, body) => {
      if (status !== 429 && status < 500) return undefined;
      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
      const errorType = typeof error?.type === "string"
        ? error.type
        : typeof error?.error_type === "string"
          ? error.error_type
          : undefined;
      const quota = errorType === "usage_limit_reached" || errorType === "usageLimitExceeded";
      const resetsAt = epochSeconds(error?.resets_at);
      const retryAfterSeconds = retryAfter(headers, mode);
      return {
        category: quota ? "quota_exhausted" : "transient",
        message: errorMessage(body, `Codex returned ${status}`),
        ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {})
      };
    },
    fetchAdminUsageCost: async (adminKey, range, signal) => {
      const query = new URLSearchParams({
        start_time: String(Math.floor(range.startTime)),
        bucket_width: "1d",
        limit: "31"
      });
      if (range.endTime !== undefined) query.set("end_time", String(Math.floor(range.endTime)));
      const headers = { authorization: `Bearer ${adminKey}` };
      const [usage, cost] = await Promise.all([
        adminRequest(info.admin.usageEndpoint, query, headers, signal),
        adminRequest(info.admin.costEndpoint, query, headers, signal)
      ]);
      return { usage, cost };
    }
  };
}

export function subscriptionProvider(mode: SubscriptionMode): SubscriptionProvider {
  switch (mode) {
    case "claude-code":
      return anthropicProvider();
    case "codex":
      return codexProvider();
    default: {
      const unreachable: never = mode;
      throw new Error(`unsupported subscription mode: ${String(unreachable)}`);
    }
  }
}
