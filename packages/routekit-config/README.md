# @velum-labs/routekit-config

`packages/routekit-config` publishes `@velum-labs/routekit-config`: reusable RouteKit
router-config discovery, layered loading, provider validation, live-model
selection, and atomic writes.

## Resolution

`loadRouterConfig()` resolves an explicit `configPath`, then
`ROUTEKIT_CONFIG`, then overlays the nearest project
`.routekit/router.yaml` on `~/.config/routekit/router.yaml`. Configuration
rejects inline credentials; providers obtain credential and optional base-URL
environment-variable names from `@velum-labs/routekit-registry`.

```ts
import {
  assertModelsAvailable,
  configuredProviderIds,
  loadRouterConfig,
  resolveModelId,
  writeRouterConfig
} from "@velum-labs/routekit-config";

const loaded = loadRouterConfig();
const providers = configuredProviderIds(loaded.config);
const liveModels = ["openai/gpt-5.5"];
const model = resolveModelId(loaded.config, liveModels);
assertModelsAvailable([model], liveModels);
```

`configuredProviderIds()` preserves declaration order. `missingModelIds()` and
`assertModelsAvailable()` compare Fusion requirements with a discovered live
catalog. `resolveModelId()` (also exported as `selectModelId`) validates an
explicit namespaced model, or selects the configured default/first live model
only when none was requested. Explicit unknown models are rejected; they never
fall through to the default. `writeRouterConfig()` and `updateRouterConfig()`
validate before atomically writing mode-0600 YAML.

## Docs

- Product docs: [fusionkit.velum-labs.com](https://fusionkit.velum-labs.com)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
