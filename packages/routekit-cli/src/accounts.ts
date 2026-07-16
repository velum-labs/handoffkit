import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  defaultSubscriptionAccountDirectory,
  enrollCurrentSubscription,
  removeSubscriptionAccount,
  startSubscriptionProxy,
  SubscriptionProxyClient
} from "@routekit/accounts";
import type {
  SubscriptionSelectionStrategy,
  SubscriptionUsageResponse
} from "@routekit/accounts";
import type { SubscriptionMode } from "@routekit/registry";
import { registerCleanup } from "@routekit/runtime";

import { readServiceRecord, registerService, stopService } from "./state.js";

export function parseAccountMode(value: string): SubscriptionMode {
  switch (value) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      throw new Error("provider must be claude or codex");
  }
}

export type AccountListEntry = {
  provider: SubscriptionMode;
  label: string;
  path: string;
};

export function listAccounts(): AccountListEntry[] {
  const providers: readonly SubscriptionMode[] = ["claude-code", "codex"];
  return providers.flatMap((provider) => {
    const directory = defaultSubscriptionAccountDirectory(provider);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => ({
        provider,
        label: name.slice(0, -".json".length),
        path: join(directory, name)
      }));
  });
}

export async function addAccount(provider: string, label?: string): Promise<AccountListEntry> {
  const mode = parseAccountMode(provider);
  const path = await enrollCurrentSubscription(mode, {
    ...(label !== undefined ? { label } : {})
  });
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return {
    provider: mode,
    label: name.endsWith(".json") ? name.slice(0, -".json".length) : name,
    path
  };
}

export function removeAccount(provider: string, label: string) {
  return removeSubscriptionAccount(parseAccountMode(provider), label);
}

export type AccountsStatus = {
  running: boolean;
  url?: string;
  pid?: number;
  usage?: SubscriptionUsageResponse;
  accounts: AccountListEntry[];
};

export async function accountsStatus(): Promise<AccountsStatus> {
  const record = readServiceRecord("accounts");
  const accounts = listAccounts();
  if (record === undefined) return { running: false, accounts };
  let usage: SubscriptionUsageResponse | undefined;
  if (record.authToken !== undefined) {
    try {
      usage = await SubscriptionProxyClient.open({
        baseUrl: record.url,
        token: record.authToken
      }).usage();
    } catch {
      usage = undefined;
    }
  }
  return {
    running: true,
    url: record.url,
    pid: record.pid,
    ...(usage !== undefined ? { usage } : {}),
    accounts
  };
}

export async function serveAccounts(input: {
  host?: string;
  port?: number;
  token?: string;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  portless?: boolean;
}): Promise<{ url: string; providers: readonly string[]; close(): Promise<void> }> {
  const policy = {
    source: { kind: "auto" as const },
    strategy: input.strategy ?? "sticky",
    switchThreshold: input.switchThreshold ?? 0.9,
    ...(input.probeIntervalMs !== undefined ? { probeIntervalMs: input.probeIntervalMs } : {})
  };
  const proxy = await startSubscriptionProxy({
    accounts: { "claude-code": policy, codex: policy },
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.token !== undefined ? { token: input.token } : {})
  });
  const registration = await registerService({
    kind: "accounts",
    loopbackUrl: proxy.url(),
    port: proxy.port(),
    authToken: proxy.token,
    ...(input.portless !== undefined ? { portless: input.portless } : {})
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await registration.release();
    await proxy.close();
  };
  registerCleanup(close);
  return { url: registration.url, providers: proxy.providers, close };
}

export async function stopAccounts(): Promise<ReturnType<typeof stopService> extends Promise<infer T> ? T : never> {
  return await stopService("accounts");
}
