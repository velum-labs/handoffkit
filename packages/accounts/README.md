# @routekit/accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, and typed proxy clients.

Account selection uses the same `CapacityPool` policy as RouteKit endpoint
routing, including sticky, round-robin, capacity-weighted, health, quota, and
cooldown behavior.

```ts
import { startSubscriptionProxy } from "@routekit/accounts";
```
