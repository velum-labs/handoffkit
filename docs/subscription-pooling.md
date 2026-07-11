# Subscription pooling architecture

The subscription proxy is an optional capability of
`@fusionkit/model-gateway`, not a parallel server stack. `startGateway` owns the
HTTP door, ingress authentication, request validation, streaming backpressure,
and abort propagation. Provider-native `SubscriptionRelay` implementations
occupy the same optional relay seam as the pre-existing Codex stock-model relay.

## Ownership

- `spec/registry/subscriptions.json`: static provider metadata (credential
  paths, OAuth refresh and usage endpoints, Admin accounting endpoints, and
  rate-limit header names).
- `subscription-provider.ts`: the only provider-specific layer. It frames
  credentials, refreshes tokens, parses first-party usage signals, and
  classifies quota failures.
- `subscription-pool.ts`: provider-independent selection, cooldown, refresh
  coalescing, storm ramp, and normalized `AccountLimits` persistence.
- `subscription-relay.ts` / `codex-relay.ts`: native HTTP forwarding. They
  strip the proxy credential and inject the selected upstream credential.
- `fusionkit proxy`: enrollment and lifecycle/status UI.

The Node `SubscriptionCredential` contract mirrors Python
`fusionkit_core.credentials.SubscriptionToken`; shared constants are generated
for both languages from the registry.

## Usage signals

Routing uses real-time subscription signals rather than Admin billing reports:

- Anthropic response headers under `anthropic-ratelimit-unified-*` and
  `GET /api/oauth/usage`.
- Codex response headers under `x-codex-*`, streamed `rate_limits` events, and
  `GET /backend-api/wham/usage`.

The public Admin usage/cost APIs are retained as registry metadata for optional
accounting integrations. They require Admin keys, lag behind live traffic, and
do not describe personal subscription windows.

## Credential lifecycle

`fusionkit proxy add` copies the current official CLI login to a private,
FusionKit-owned pool file. The proxy may rotate one-time refresh tokens only in
that copy; it never writes the canonical official CLI store. Refreshes are
single-flight per member and reset stale observed-window state.

The default sticky policy preserves account-scoped prompt caches. Quota
rejection cools the member until its first-party reset timestamp and selects a
new member. Short transient throttles are absorbed on the same account.
