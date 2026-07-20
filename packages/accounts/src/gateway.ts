import type { SubscriptionMode } from "@routekit/registry";

import { CodexBackendRelay } from "./codex-relay.js";
import type { CodexCatalogEntry, CodexRelayOptions } from "./codex-relay.js";
import { SubscriptionAccountSet } from "./account-set.js";
import type { SubscriptionAccountSetOptions } from "./account-set.js";
import { subscriptionProvider } from "./provider.js";
import { AnthropicBackendRelay } from "./relay.js";
import type {
  SubscriptionRelay,
  SubscriptionRelayDialect
} from "./relay.js";

export type SubscriptionAccountConfigs = Partial<
  Record<SubscriptionMode, Omit<SubscriptionAccountSetOptions, "mode">>
>;

export type OpenSubscriptionRelaysOptions = {
  accounts: SubscriptionAccountConfigs;
  codex?: Omit<CodexRelayOptions, "auth">;
};

export type OpenSubscriptionRelaysResult = {
  relays: Partial<Record<SubscriptionRelayDialect, SubscriptionRelay>>;
  accountSets: SubscriptionAccountSets;
};

export type SubscriptionAccountSets = Partial<
  Record<SubscriptionMode, SubscriptionAccountSet>
>;

function stockCatalog(
  _template: CodexCatalogEntry,
  stock: readonly CodexCatalogEntry[]
): CodexCatalogEntry[] {
  return [...stock];
}

export async function openSubscriptionAccountSets(
  configs: SubscriptionAccountConfigs
): Promise<SubscriptionAccountSets> {
  const sets: SubscriptionAccountSets = {};
  try {
    for (const mode of ["claude-code", "codex"] as const) {
      const config = configs[mode];
      if (config === undefined) continue;
      sets[mode] = await SubscriptionAccountSet.open(subscriptionProvider(mode), {
        mode,
        ...config
      });
    }
    return sets;
  } catch (error) {
    await Promise.all(
      Object.values(sets).map(async (accounts) => await accounts.close())
    );
    throw error;
  }
}

export function subscriptionRelaysFromAccountSets(
  sets: SubscriptionAccountSets,
  codex?: Omit<CodexRelayOptions, "auth">
): Partial<Record<SubscriptionRelayDialect, SubscriptionRelay>> {
  const relays: Partial<Record<SubscriptionRelayDialect, SubscriptionRelay>> = {};
  const claude = sets["claude-code"];
  if (claude !== undefined && claude.size > 0) {
    relays.anthropic = new AnthropicBackendRelay({ accounts: claude });
  }
  const codexAccounts = sets.codex;
  if (codexAccounts !== undefined && codexAccounts.size > 0) {
    relays.codex = new CodexBackendRelay({
      catalog: stockCatalog,
      ...codex,
      auth: { kind: "accounts", accounts: codexAccounts }
    });
  }
  return relays;
}

/** Open every configured server-owned subscription through one account-set path. */
export async function openSubscriptionRelays(
  options: OpenSubscriptionRelaysOptions
): Promise<OpenSubscriptionRelaysResult> {
  const sets = await openSubscriptionAccountSets(options.accounts);
  const relays = subscriptionRelaysFromAccountSets(sets, options.codex);
  for (const mode of ["claude-code", "codex"] as const) {
    const accounts = sets[mode];
    if (accounts === undefined) continue;
    const hasRelay =
      (mode === "claude-code" && relays.anthropic !== undefined) ||
      (mode === "codex" && relays.codex !== undefined);
    if (!hasRelay) {
      await accounts.close();
      delete sets[mode];
    }
  }
  return { relays, accountSets: sets };
}
