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
};

function stockCatalog(
  _template: CodexCatalogEntry,
  stock: readonly CodexCatalogEntry[]
): CodexCatalogEntry[] {
  return [...stock];
}

/** Open every configured server-owned subscription through one account-set path. */
export async function openSubscriptionRelays(
  options: OpenSubscriptionRelaysOptions
): Promise<OpenSubscriptionRelaysResult> {
  const relays: Partial<Record<SubscriptionRelayDialect, SubscriptionRelay>> = {};
  const claude = options.accounts["claude-code"];
  if (claude !== undefined) {
    const accounts = await SubscriptionAccountSet.open(
      subscriptionProvider("claude-code"),
      { mode: "claude-code", ...claude }
    );
    if (accounts.size > 0) relays.anthropic = new AnthropicBackendRelay({ accounts });
    else await accounts.close();
  }

  const codex = options.accounts.codex;
  if (codex !== undefined) {
    const accounts = await SubscriptionAccountSet.open(subscriptionProvider("codex"), {
      mode: "codex",
      ...codex
    });
    if (accounts.size > 0) {
      relays.codex = new CodexBackendRelay({
        catalog: stockCatalog,
        ...options.codex,
        auth: { kind: "accounts", accounts }
      });
    } else {
      await accounts.close();
    }
  }
  return { relays };
}
