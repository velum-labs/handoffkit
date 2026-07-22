/**
 * Local, read-only account-store views for the thin CLI (shell completion and
 * offline status). Login capture, connector dispatch, and the CLIProxyAPI
 * store live in `@routekit/accounts`; the daemon is the sole account-state
 * writer.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  cliproxyAccountEntries,
  defaultSubscriptionAccountDirectory
} from "@routekit/accounts";
import type { SubscriptionMode } from "@routekit/registry";

export type AccountListEntry = {
  subscriptionKind: string;
  label: string;
  path: string;
  connector: "native" | "cliproxy";
};

export function listAccounts(): AccountListEntry[] {
  const subscriptionKinds: readonly SubscriptionMode[] = ["claude-code", "codex"];
  const native = subscriptionKinds.flatMap((subscriptionKind) => {
    const directory = defaultSubscriptionAccountDirectory(subscriptionKind);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => ({
        subscriptionKind,
        label: name.slice(0, -".json".length),
        path: join(directory, name),
        connector: "native" as const
      }));
  });
  const cliproxy = cliproxyAccountEntries().map((entry) => ({
    subscriptionKind: entry.kind,
    label: entry.label,
    path: entry.path,
    connector: "cliproxy" as const
  }));
  return [...native, ...cliproxy];
}
