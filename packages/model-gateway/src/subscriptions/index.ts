/**
 * `@fusionkit/model-gateway/subscriptions` — the subscription pooling SDK.
 *
 * A cohesive, typed surface for pooling Claude Code and Codex OAuth
 * subscriptions behind one provider-native proxy: resolve an account set from
 * the official CLI login / an enrolled directory / explicit paths, select and
 * refresh members with quota-aware routing, and expose it over the gateway wire
 * protocols. `startSubscriptionProxy` is the one-call programmatic entrypoint;
 * `SubscriptionProxyClient` reads a running proxy's usage over a typed wire
 * contract. The CLI (`fusionkit proxy`) is a thin wrapper over this module.
 */

// Account credentials + enrollment
export {
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath,
  enrollCurrentSubscription,
  loadSubscriptionCredential,
  persistSubscriptionCredential,
  sanitizeSubscriptionLabel,
  subscriptionCredentialLabel
} from "./credentials.js";

// Account sources (canonical / directory / explicit)
export { resolveSubscriptionAccounts } from "./account-source.js";
export type {
  ResolvedSubscriptionAccounts,
  SubscriptionAccountSource
} from "./account-source.js";

// Provider adapters
export { subscriptionProvider } from "./provider.js";
export type {
  AdminUsageCost,
  AdminUsageRange,
  SubscriptionProvider
} from "./provider.js";

// Account set (selection, cooldown, refresh, usage tracking)
export {
  RateLimitTracker,
  SubscriptionAccountSet,
  SubscriptionAccountSetExhaustedError
} from "./account-set.js";
export type { SubscriptionAccountSetOptions } from "./account-set.js";

// Relays (provider-native forwarding)
export { CodexBackendRelay, codexRelayAuth } from "./codex-relay.js";
export type {
  CodexCatalogEntry,
  CodexRelayAuth,
  CodexRelayAuthSource,
  CodexRelayOptions,
  CodexStockEntry
} from "./codex-relay.js";
export {
  AnthropicBackendRelay,
  forwardRelayHeaders,
  RelayOnlyBackend
} from "./relay.js";
export type {
  AnthropicRelayOptions,
  SubscriptionRelay,
  SubscriptionRelayDialect
} from "./relay.js";

// Gateway relay construction
export { openSubscriptionRelays } from "./gateway.js";
export type {
  OpenSubscriptionRelaysOptions,
  OpenSubscriptionRelaysResult,
  SubscriptionAccountConfigs
} from "./gateway.js";

// Programmatic proxy + typed client
export { NoSubscriptionAccountsError, startSubscriptionProxy } from "./proxy.js";
export type {
  StartSubscriptionProxyOptions,
  SubscriptionProxy
} from "./proxy.js";
export { SubscriptionProxyClient, SubscriptionProxyClientError } from "./client.js";
export type { SubscriptionProxyClientOptions } from "./client.js";

// Wire contract for the proxy usage endpoint
export {
  snapshotsToUsage,
  SUBSCRIPTION_USAGE_PATH,
  subscriptionUsageResponseSchema
} from "./wire.js";
export type { SubscriptionUsageResponse } from "./wire.js";

// Shared value types
export type {
  AccountLimits,
  CreditSnapshot,
  RateLimitWindow,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionMemberStatus,
  SubscriptionSelectionStrategy
} from "./types.js";
