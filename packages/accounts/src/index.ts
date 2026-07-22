/**
 * `@routekit/accounts` — the subscription pooling SDK.
 *
 * A cohesive, typed surface for pooling Claude Code and Codex OAuth
 * subscriptions behind one provider-native proxy: resolve an account set from
 * the official CLI login / an enrolled directory / explicit paths, select and
 * refresh members with quota-aware routing, and expose it over the gateway wire
 * protocols. `startSubscriptionProxy` is the one-call programmatic entrypoint;
 * `SubscriptionProxyClient` reads a running proxy's usage over a typed wire
 * contract. Product CLIs can wrap this module without owning account logic.
 */

// Account credentials + enrollment
export {
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath,
  enrollCurrentSubscription,
  loadSubscriptionCredential,
  persistSubscriptionCredential,
  removeSubscriptionAccount,
  sanitizeSubscriptionLabel,
  subscriptionCredentialLabel
} from "./credentials.js";
export type { RemoveSubscriptionAccountResult } from "./credentials.js";

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

// OpenAI-compatible backend over a subscription account set
export { SubscriptionAccountBackend } from "./backend.js";
export type { SubscriptionAccountBackendOptions } from "./backend.js";

// Relays (provider-native forwarding)
export { CodexBackendRelay, codexRelayAuth } from "./codex-relay.js";
export type {
  CodexCatalogEntry,
  CodexRelayAuth,
  CodexRelayAuthSource,
  CodexRelayOptions,
  ProviderRelayLogger,
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
export {
  openSubscriptionAccountSets,
  openSubscriptionRelays,
  subscriptionRelaysFromAccountSets
} from "./gateway.js";
export type {
  OpenSubscriptionRelaysOptions,
  OpenSubscriptionRelaysResult,
  SubscriptionAccountConfigs,
  SubscriptionAccountSets
} from "./gateway.js";

// Programmatic proxy + typed client
export { NoSubscriptionAccountsError, startSubscriptionProxy } from "./proxy.js";
export type {
  StartSubscriptionProxyOptions,
  SubscriptionProxy
} from "./proxy.js";
export { SubscriptionProxyClient, SubscriptionProxyClientError } from "./client.js";
export type { SubscriptionProxyClientOptions } from "./client.js";

// Fresh usage collection over live or locally opened account sets
export {
  collectSubscriptionUsage,
  DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS,
  openLocalSubscriptionUsage
} from "./usage.js";
export type { SubscriptionUsageSource } from "./usage.js";

// Managed CLIProxyAPI lifecycle
export {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_HOME_ENV,
  CLIPROXY_PINNED_VERSION,
  cliproxyAssetName,
  cliproxyApiKey,
  cliproxyBaseUrl,
  cliproxyBinaryPath,
  cliproxyConfigPath,
  cliproxyHome,
  cliproxyManagedPort,
  cliproxyStatus,
  ensureCliproxyConfig,
  installCliproxy,
  spawnCliproxy
} from "./cliproxy.js";
export type { CliproxyInstallResult, CliproxyStatus } from "./cliproxy.js";

// Account connectors: one login surface over native + cliproxy mechanisms
export {
  accountStoreEntries,
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  loginCliproxyAccount,
  removeCliproxyAccount,
  resolveAccountKind
} from "./connector.js";
export type {
  AccountStoreEntry,
  CliproxyAccountEntry,
  CliproxyLoginInvocation,
  CliproxyLoginOptions,
  ResolvedAccountKind
} from "./connector.js";

// Native-connector managed logins (official CLI in an isolated profile)
export {
  captureLoginCredential,
  claudeProfileKeychainService,
  parseAccountMode
} from "./managed-login.js";
export type {
  ManagedAccountLoginInvocation,
  ManagedAccountLoginOptions,
  ManagedLoginKeychain
} from "./managed-login.js";

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
  RateLimitObservationSource,
  RateLimitWindow,
  SubscriptionAccountSetSnapshot,
  SubscriptionCredential,
  SubscriptionFailure,
  SubscriptionMemberStatus,
  SubscriptionSelectionStrategy
} from "./types.js";
