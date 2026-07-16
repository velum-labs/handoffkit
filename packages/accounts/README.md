# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, typed proxy clients, and the managed CLIProxyAPI lifecycle.

Account selection uses the same `CapacityPool` policy as RouteKit endpoint
routing, including sticky, round-robin, capacity-weighted, health, quota, and
cooldown behavior.

The canonical subscription kinds are `claude-code` and `codex`. The RouteKit
tool command is still `routekit claude`; tool names and subscription kinds are
separate contracts. `routekit accounts add <kind>` imports the current official
CLI login and enables that kind in the effective router config.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```

CLIProxyAPI state is owned under `~/.routekit/cliproxy` (or `ROUTEKIT_HOME`).
Use `routekit accounts cliproxy install|login|serve|status`; credential values
remain in private files and are never printed. CLIProxy login does not create a
RouteKit endpoint: keep the proxy serving and add its URL-backed endpoint
explicitly with `routekit endpoints add`.

`routekit accounts serve` is an advanced external-proxy mode. Normal RouteKit
account-backed endpoints use the in-process subscription backend and do not
require that command.
