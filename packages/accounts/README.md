# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, typed proxy clients, and the managed CLIProxyAPI lifecycle.

Account selection uses the same `CapacityPool` policy as RouteKit endpoint
routing, including sticky, round-robin, capacity-weighted, health, quota, and
cooldown behavior.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```

CLIProxyAPI state is owned under `~/.routekit/cliproxy` (or `ROUTEKIT_HOME`).
Use `routekit accounts cliproxy install|login|serve|status`; credential values
remain in private files and are never printed.
