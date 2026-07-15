# Subscription pooling architecture

The subscription proxy is a cohesive SDK published under the
`@routekit/accounts` subpath, not a pile of exports on the
gateway's core entrypoint. The core `startGateway` still owns the HTTP door,
ingress authentication, request validation, streaming backpressure, and abort
propagation; the subscriptions module supplies the relays, account sets,
provider adapters, programmatic proxy, and typed client that plug into it.

## SDK surface (`@routekit/accounts`)

- `startSubscriptionProxy(options)`: the one-call programmatic entrypoint —
  opens the configured account sets into relays, fronts them with a relay-only
  gateway, and returns `{ url, port, token, providers, usage(), close() }`. The
  CLI `fusionkit proxy serve` is a thin wrapper over it.
- `SubscriptionProxyClient`: a typed client for a running proxy; `usage()`
  parses through the shared wire schema so consumers never re-declare the shape.
- `subscriptionUsageResponseSchema` / `SubscriptionUsageResponse`: the zod wire
  contract for `GET /usage`, shared by the gateway server (producer) and the
  client (consumer).
- `SubscriptionAccountSet` + `openSubscriptionRelays`, provider adapters,
  credential/enrollment helpers, and relays.

## Ownership

- `spec/registry/subscriptions.json`: static provider metadata (credential
  paths, OAuth refresh and usage endpoints, Admin accounting endpoints, and
  rate-limit header names).
- `subscriptions/provider.ts`: the only provider-specific layer. It frames
  credentials, refreshes tokens, parses first-party usage signals, and
  classifies quota failures.
- `subscriptions/account-source.ts`: resolves the official CLI login, an
  enrolled directory, or explicit paths into one account sequence. An empty
  managed directory imports the canonical login as a one-member set.
- `subscriptions/account-set.ts`: the provider-independent `SubscriptionAccountSet`
  selection, cooldown, refresh coalescing, storm ramp, and normalized
  `AccountLimits` persistence.
- `subscriptions/gateway.ts`: the single relay-opening path shared by the
  standalone proxy and fusion gateway.
- `subscriptions/relay.ts` / `subscriptions/codex-relay.ts`: native HTTP
  forwarding. They strip the proxy credential and inject the selected upstream
  credential.
- `subscriptions/proxy.ts` / `subscriptions/client.ts` / `subscriptions/wire.ts`:
  the programmatic proxy, typed client, and shared usage wire contract.
- `packages/cli/src/fusion/subscription-proxy.ts`: the CLI daemon lifecycle —
  records the running proxy, registers a `subscriptions.fusion.localhost`
  portless route (so `fusionkit stop` reaps it), and discovers/stops it. The
  `fusionkit proxy` commands are thin wrappers over the SDK plus this helper.

The Node `SubscriptionCredential` contract mirrors Python
`fusionkit_core.credentials.SubscriptionToken`; shared constants are generated
for both languages from the registry.

## Exhaustion

When every pooled account for a request's model is spent or cooling, the account
set raises `SubscriptionAccountSetExhaustedError`, and the gateway maps it to an
HTTP `429` with a `Retry-After` derived from the soonest reset instead of a
generic `502`.

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

On first use, the current official CLI login is copied to a private,
FusionKit-owned account file. `fusionkit proxy add` grows the same account set;
it accepts only `claude-code` or `codex` as the provider argument. The managed
account state lives under `~/.fusionkit/subscriptions` (override with
`FUSIONKIT_SUBSCRIPTIONS_DIR`), and clients authenticate to the proxy with the
bearer token `proxy serve` prints (the Codex snippet references it via the
`FUSIONKIT_PROXY_TOKEN` env var). The proxy may rotate one-time refresh tokens
only in managed copies; it never writes the canonical official CLI store.
Refreshes are single-flight per member and reset stale observed-window state.

The default sticky policy preserves account-scoped prompt caches. Quota
rejection cools the member until its first-party reset timestamp and selects a
new member. Short transient throttles are absorbed on the same account.
