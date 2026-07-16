# @routekit/gateway

Product-neutral model routing and provider egress for RouteKit.

The package owns the `Backend` interface, HTTP gateway, OpenAI Chat,
Responses, Anthropic Messages and Cursor adapters, SSE handling, ACP support,
normalized call provenance, runtime-validated router configuration, model
catalogs, endpoint pools, and provider-native egress.

It routes opaque endpoint IDs to already-running HTTP services. It never
starts or manages model-server processes.

```ts
import {
  CatalogBackend,
  parseRouterConfig,
  startGateway
} from "@routekit/gateway";
```

Provider subscription accounts and relays are in `@routekit/accounts`.
Product-specific orchestration is in `@fusionkit/gateway`.
