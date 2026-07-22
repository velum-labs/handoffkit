# @fusionkit/registry

Generated FusionKit model identities and panel presets.

## Architecture

The registry is generated from `spec/registry/fusion.json`. Product-neutral
provider, subscription, catalog, capability, pricing, and local model metadata
lives in `@routekit/registry`.

## Usage

Use it when building custom launchers that need FusionKit model metadata.

```ts
import * as fusionkitPackage from "@fusionkit/registry";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
