# @fusionkit/workspace

Git workspace capture and worktree helpers for FusionKit.

## Architecture

FusionKit panels run candidate models in lightweight git worktrees; this package handles safe capture, materialization, output collection, and divergence checks.

## Usage

Most users reach it through `@fusionkit/cli`; import it directly for custom panel orchestration.

```ts
import * as fusionkitPackage from "@fusionkit/workspace";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
