import { CLIPROXY_API_KEY_ENV, cliproxyApiKey } from "@routekit/accounts";
import { contextFor, CliError } from "@routekit/cli-core";
import { configuredProviderIds } from "@routekit/config";
import { isSubscriptionProvider } from "@routekit/gateway";
import type { ProviderId, RouterConfig } from "@routekit/gateway";
import { defaultKeyEnv } from "@routekit/registry";
import { dim, glyph, renderTableLines, watch } from "@routekit/cli-ui";
import type { Command } from "commander";

import { accountsStatus } from "../accounts.js";
import type { AccountsStatus } from "../accounts.js";
import { readServiceRecord, readStateSnapshot } from "../state.js";
import type { RouteKitServiceRecord, ServiceKind } from "../state.js";
import { limitsSummary } from "../usage-format.js";

import { loaded } from "./context.js";

type CachedProviderHealth = {
  checkedAt?: string;
  providers: Array<{ provider: string; ok: boolean; error?: string; models?: readonly string[] }>;
};

type CachedCatalog = {
  updatedAt?: string;
  defaultModel?: string;
  models: Array<string | { id: string; provider?: string }>;
};

export type RouteKitOverview = {
  observedAt: string;
  services: Array<{
    kind: ServiceKind;
    running: boolean;
    url?: string;
    pid?: number;
    startedAt?: string;
    uptimeSeconds?: number;
    reachable?: boolean;
    error?: string;
  }>;
  providers: Array<{
    provider: string;
    configured: true;
    credentialAvailable: boolean;
    credential: string;
    lastCheck?: { ok: boolean; checkedAt?: string; error?: string; models?: number };
  }>;
  accounts: AccountsStatus;
  models: {
    count: number;
    defaultModel?: string;
    updatedAt?: string;
    cached: boolean;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cachedHealth(): CachedProviderHealth | undefined {
  const value = record(readStateSnapshot("health", "providers"));
  if (value === undefined || !Array.isArray(value.providers)) return undefined;
  const providers = value.providers.flatMap((entry) => {
    const item = record(entry);
    if (typeof item?.provider !== "string" || typeof item.ok !== "boolean") return [];
    return [{
      provider: item.provider,
      ok: item.ok,
      ...(typeof item.error === "string" ? { error: item.error } : {}),
      ...(Array.isArray(item.models) ? { models: item.models.filter((model): model is string => typeof model === "string") } : {})
    }];
  });
  return {
    ...(typeof value.checkedAt === "string" ? { checkedAt: value.checkedAt } : {}),
    providers
  };
}

function cachedCatalog(): CachedCatalog | undefined {
  const value = record(readStateSnapshot("catalog", "models"));
  if (value === undefined || !Array.isArray(value.models)) return undefined;
  const models = value.models.flatMap((entry): CachedCatalog["models"] => {
    if (typeof entry === "string") return [entry];
    const item = record(entry);
    if (typeof item?.id !== "string") return [];
    return [{ id: item.id, ...(typeof item.provider === "string" ? { provider: item.provider } : {}) }];
  });
  return {
    models,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.defaultModel === "string" ? { defaultModel: value.defaultModel } : {})
  };
}

function serviceOverview(
  kind: ServiceKind,
  service: RouteKitServiceRecord | undefined,
  now: number,
  probe?: { reachable: boolean; error?: string }
): RouteKitOverview["services"][number] {
  if (service === undefined) return { kind, running: false };
  const started = Date.parse(service.startedAt);
  return {
    kind,
    running: true,
    url: service.url,
    pid: service.pid,
    startedAt: service.startedAt,
    ...(Number.isFinite(started) ? { uptimeSeconds: Math.max(0, Math.round((now - started) / 1000)) } : {}),
    ...(probe !== undefined ? { reachable: probe.reachable } : {}),
    ...(probe?.error !== undefined ? { error: probe.error } : {})
  };
}

export async function routeKitOverview(config: RouterConfig, now = Date.now()): Promise<RouteKitOverview> {
  const accounts = await accountsStatus(config);
  const health = cachedHealth();
  const catalog = cachedCatalog();
  const providers = configuredProviderIds(config).map((configuredProvider) => {
    const provider = configuredProvider as ProviderId;
    const keyEnv = defaultKeyEnv(provider);
    const credentialValue = keyEnv === undefined
      ? undefined
      : process.env[keyEnv] ?? (keyEnv === CLIPROXY_API_KEY_ENV ? cliproxyApiKey() : undefined);
    const credentialAvailable = isSubscriptionProvider(provider)
      ? accounts.accounts.some((entry) => entry.subscriptionKind === provider && entry.credentialValid)
      : keyEnv === undefined
        ? true
        : credentialValue !== undefined && credentialValue.trim().length > 0;
    const checked = health?.providers.find((entry) => entry.provider === provider);
    return {
      provider,
      configured: true as const,
      credentialAvailable,
      credential: isSubscriptionProvider(provider) ? "managed accounts" : (keyEnv ?? "registry managed"),
      ...(checked !== undefined ? {
        lastCheck: {
          ok: checked.ok,
          ...(health?.checkedAt !== undefined ? { checkedAt: health.checkedAt } : {}),
          ...(checked.error !== undefined ? { error: checked.error } : {}),
          ...(checked.models !== undefined ? { models: checked.models.length } : {})
        }
      } : {})
    };
  });
  return {
    observedAt: new Date(now).toISOString(),
    services: [
      serviceOverview("gateway", readServiceRecord("gateway"), now),
      serviceOverview(
        "accounts",
        readServiceRecord("accounts"),
        now,
        {
          reachable: accounts.usageError === undefined,
          ...(accounts.usageError !== undefined ? { error: accounts.usageError } : {})
        }
      )
    ],
    providers,
    accounts,
    models: {
      count: catalog?.models.length ?? 0,
      ...((catalog?.defaultModel ?? config.defaultModel) !== undefined
        ? { defaultModel: catalog?.defaultModel ?? config.defaultModel }
        : {}),
      ...(catalog?.updatedAt !== undefined ? { updatedAt: catalog.updatedAt } : {}),
      cached: catalog !== undefined
    }
  };
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function stateMark(ok: boolean): string {
  return ok ? glyph.tick() : glyph.pending();
}

export function renderOverviewLines(overview: RouteKitOverview): string[] {
  const lines = ["RouteKit status", "", "Services"];
  lines.push(...renderTableLines(overview.services.map((service) => [
    stateMark(service.running && service.reachable !== false),
    service.kind,
    service.running
      ? `${service.url ?? ""}${service.reachable === false ? " (usage unavailable)" : ""}`
      : "stopped",
    service.running ? `pid ${service.pid ?? "?"} · up ${duration(service.uptimeSeconds)}` : ""
  ]), { head: ["", "service", "state", "process"], indent: 2 }));
  lines.push("", "Providers");
  lines.push(...renderTableLines(overview.providers.map((provider) => [
    stateMark(provider.credentialAvailable && provider.lastCheck?.ok !== false),
    provider.provider,
    provider.credentialAvailable ? provider.credential : `${provider.credential} missing`,
    provider.lastCheck === undefined
      ? "not checked"
      : provider.lastCheck.ok
        ? `${provider.lastCheck.models ?? 0} model(s)`
        : provider.lastCheck.error ?? "last check failed"
  ]), { head: ["", "provider", "credential", "last live check"], indent: 2 }));
  lines.push("", "Accounts");
  if (overview.accounts.accounts.length === 0) lines.push("  no enrolled accounts");
  for (const account of overview.accounts.accounts) {
    const ready = account.credentialValid && account.configured;
    const summary = limitsSummary(
      overview.accounts.usage,
      account.subscriptionKind,
      account.label
    );
    lines.push(
      `  ${stateMark(ready)} ${account.subscriptionKind}/${account.label} · ${ready ? "ready" : !account.credentialValid ? "invalid credential" : "routing disabled"}${summary === undefined ? "" : ` · ${summary}`}`
    );
  }
  lines.push("", "Models");
  lines.push(
    `  ${overview.models.cached ? stateMark(true) : stateMark(false)} ${overview.models.count} cached model(s)` +
      `${overview.models.defaultModel === undefined ? "" : ` · default ${overview.models.defaultModel}`}`
  );
  if (overview.models.updatedAt !== undefined) lines.push(dim(`  catalog updated ${overview.models.updatedAt}`));
  const gateway = overview.services.find((service) => service.kind === "gateway");
  if (gateway?.running !== true) lines.push("", "→ try: routekit gateway serve");
  if (
    overview.providers.some((provider) => !provider.credentialAvailable || provider.lastCheck?.ok === false)
  ) {
    lines.push("→ try: routekit doctor");
  }
  return lines;
}

function interval(value: string | boolean): number {
  if (value === true) return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 86_400) {
    throw new CliError({ message: "watch interval must be between 0.1 and 86400 seconds" });
  }
  return parsed;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("show services, providers, accounts, and cached models at a glance")
    .option("--watch [seconds]", "refresh continuously (default: 5 seconds)")
    .action(async (options: { watch?: string | boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.watch !== undefined && ctx.json) {
        throw new CliError({
          message: "`status --watch` is a live human view and cannot be combined with --json"
        });
      }
      const config = loaded(command).config;
      const collect = async (): Promise<RouteKitOverview> => routeKitOverview(config);
      if (options.watch !== undefined) {
        await watch(ctx.presenter, interval(options.watch), async () =>
          renderOverviewLines(await collect())
        );
        return;
      }
      const overview = await collect();
      if (ctx.json) ctx.emit(overview);
      else for (const line of renderOverviewLines(overview)) ctx.presenter.line(line);
    });
}
