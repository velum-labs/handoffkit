import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  defaultSubscriptionAccountDirectory,
  enrollCurrentSubscription,
  loadSubscriptionCredential,
  removeSubscriptionAccount,
  startSubscriptionProxy,
  SubscriptionProxyClient
} from "@routekit/accounts";
import type {
  SubscriptionSelectionStrategy,
  SubscriptionUsageResponse
} from "@routekit/accounts";
import type { SubscriptionMode } from "@routekit/registry";
import type { RouterConfig } from "@routekit/gateway";
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
      throw new Error("subscription kind must be claude-code or codex");
  }
}

export type AccountListEntry = {
  subscriptionKind: SubscriptionMode;
  /** @deprecated Use subscriptionKind. */
  provider: SubscriptionMode;
  label: string;
  path: string;
};

export function listAccounts(): AccountListEntry[] {
  const subscriptionKinds: readonly SubscriptionMode[] = ["claude-code", "codex"];
  return subscriptionKinds.flatMap((subscriptionKind) => {
    const directory = defaultSubscriptionAccountDirectory(subscriptionKind);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => ({
        subscriptionKind,
        provider: subscriptionKind,
        label: name.slice(0, -".json".length),
        path: join(directory, name)
      }));
  });
}

export async function addAccount(
  subscriptionKindInput: string,
  label?: string
): Promise<AccountListEntry> {
  const subscriptionKind = parseAccountMode(subscriptionKindInput);
  const path = await enrollCurrentSubscription(subscriptionKind, {
    ...(label !== undefined ? { label } : {})
  });
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return {
    subscriptionKind,
    provider: subscriptionKind,
    label: name.endsWith(".json") ? name.slice(0, -".json".length) : name,
    path
  };
}

export function removeAccount(subscriptionKindInput: string, label: string) {
  return removeSubscriptionAccount(parseAccountMode(subscriptionKindInput), label);
}

export type AccountsStatus = {
  running: boolean;
  url?: string;
  pid?: number;
  usage?: SubscriptionUsageResponse;
  accounts: Array<
    AccountListEntry & {
      credentialValid: boolean;
      configured: boolean;
      relayOpen: boolean;
    }
  >;
};

export async function accountsStatus(config?: RouterConfig): Promise<AccountsStatus> {
  const record = readServiceRecord("accounts");
  const accounts = await Promise.all(
    listAccounts().map(async (entry) => {
      let credentialValid = false;
      try {
        await loadSubscriptionCredential(entry.subscriptionKind, entry.path);
        credentialValid = true;
      } catch {
        credentialValid = false;
      }
      const configured =
        config?.accounts?.[entry.subscriptionKind]?.enabled === true;
      return {
        ...entry,
        credentialValid,
        configured,
        relayOpen: configured && credentialValid
      };
    })
  );
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
