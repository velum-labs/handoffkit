# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, typed proxy clients, and the managed CLIProxyAPI lifecycle.

Account selection uses RouteKit provider policy, including sticky,
round-robin, capacity-weighted, health, quota, and cooldown behavior. Discovery
runs against every healthy account; the provider publishes the union of models
and tracks which accounts are eligible for each model.

The canonical subscription kinds are `claude-code` and `codex`. The RouteKit
tool command is still `routekit claude`; tool names and subscription kinds are
separate contracts. The RouteKit CLI's default
`accounts login <kind> --name <label>` flow runs the official provider login in
isolated temporary state before enrolling it. `accounts add` explicitly imports
the current official CLI login. Any number of named accounts may join a
provider; the first enrollment enables that provider in the effective router
config.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```

CLIProxyAPI state is owned under `~/.routekit/cliproxy` (or `ROUTEKIT_HOME`).
Use `routekit accounts cliproxy install|login|serve|status`; credential values
remain in private files and are never printed. CLIProxy login does not enable a
RouteKit provider: keep the proxy serving and run
`routekit providers add cliproxy`.

`routekit accounts serve` is an advanced external-proxy mode. Normal RouteKit
subscription providers use the in-process backend and do not require that
command.
