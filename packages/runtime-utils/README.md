# @routekit/runtime

Brand-neutral runtime utilities shared by RouteKit and product packages.

## Architecture

This package contains leaf helpers for process control, timeouts, formatting,
markdown reports, and runtime defaults. URL/bind normalization and child
environment policy live in focused internal modules while the package keeps one
stable `@routekit/runtime` root export.

## Usage

Most users install it through a higher-level package.

```ts
import { superviseSpawn, writeFileAtomic } from "@routekit/runtime";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
