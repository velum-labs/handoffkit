# @routekit/config

`packages/routekit-config` publishes `@routekit/config`: reusable RouteKit
router-config discovery, layered loading, validation, endpoint selection, and
atomic writes.

## Resolution

`loadRouterConfig()` resolves an explicit `configPath`, then
`ROUTEKIT_CONFIG`, then overlays the nearest project
`.routekit/router.yaml` on `~/.config/routekit/router.yaml`. Configuration
rejects inline credentials; endpoints refer to environment-variable names with
`apiKeyEnv`.

```ts
import {
  assertEndpointIdsConfigured,
  configuredEndpointIds,
  loadRouterConfig,
  resolveEndpointId,
  writeRouterConfig
} from "@routekit/config";

const loaded = loadRouterConfig();
const endpointId = resolveEndpointId(loaded.config);
assertEndpointIdsConfigured([endpointId], configuredEndpointIds(loaded.config));
```

`configuredEndpointIds()`, `missingEndpointIds()`, and
`assertEndpointIdsConfigured()` provide declaration-order endpoint checks.
`resolveEndpointId()` (also exported as `selectEndpointId`) selects an explicit,
default, or first configured endpoint. `writeRouterConfig()` and
`updateRouterConfig()` validate before atomically writing mode-0600 YAML.

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
