# @routekit/gateway

Product-neutral model routing and provider egress for RouteKit.

The package owns the `Backend` interface, HTTP gateway, OpenAI Chat,
Responses, Anthropic Messages and Cursor adapters, SSE handling, ACP support,
normalized call provenance, runtime-validated router configuration, model
catalogs, provider sources, and provider-native egress.

At startup `CatalogBackend` authenticates every explicitly configured provider,
performs live model discovery, and publishes source-qualified
`provider/model` IDs. Dispatch removes the source prefix before provider-native
egress. An unavailable provider fails startup rather than silently shrinking
the catalog.

```ts
import {
  CatalogBackend,
  parseRouterConfig,
  startGateway
} from "@routekit/gateway";
```

API-key providers use registry-defined credentials and URLs. Multi-account
subscription providers and relays are in `@routekit/accounts`; they expose the
same source interface with per-model account eligibility and quota-aware
selection.
Product-specific orchestration is in `@fusionkit/gateway`.
