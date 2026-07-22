# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, typed proxy clients, account connectors, and the managed
CLIProxyAPI lifecycle.

Account selection uses RouteKit provider policy, including sticky,
round-robin, capacity-weighted, health, quota, and cooldown behavior. Discovery
runs against every healthy account; the provider publishes the union of models
and tracks which accounts are eligible for each model.

The first-launch RouteKit subscription kinds are `claude-code` and `codex`.
They run the official provider login in isolated temporary state
(`captureLoginCredential`) before enrolling. Any number of named accounts may
join a provider; the first enrollment enables that provider in the effective
router config. The RouteKit tool command is still `routekit claude`; tool names
and subscription kinds are separate contracts.

This neutral package retains other connector implementations for compatibility
and development. Those registry entries and exported APIs are internal,
unqualified, and non-contractual; they are not RouteKit onboarding or support.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```

Retained connector state remains private under `ROUTEKIT_HOME`; credential
values are never printed.
