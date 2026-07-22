# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, typed proxy clients, account connectors, and the managed
CLIProxyAPI lifecycle.

Account selection uses RouteKit provider policy, including sticky,
round-robin, capacity-weighted, health, quota, and cooldown behavior. Discovery
runs against every healthy account; the provider publishes the union of models
and tracks which accounts are eligible for each model.

The subscription kinds are `claude-code`, `codex`, `gemini`, `grok`, and
`kimi`; the registry's connector map declares which mechanism backs each kind
(`resolveAccountKind`). The RouteKit tool command is still `routekit claude`;
tool names and subscription kinds are separate contracts. The RouteKit CLI's
one `accounts login <kind>` flow dispatches by connector: native kinds run the
official provider login in isolated temporary state (`captureLoginCredential`)
before enrolling; cliproxy-backed kinds install and run the pinned CLIProxyAPI
OAuth flow (`loginCliproxyAccount`). Any number of named accounts may join a
provider; the first enrollment enables that provider in the effective router
config.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```

CLIProxyAPI state is owned under `~/.routekit/cliproxy` (or `ROUTEKIT_HOME`);
credential values remain in private files and are never printed. The RouteKit
daemon supervises the sidecar process itself — there is no user-facing
install/serve command and no separate accounts-proxy command.
