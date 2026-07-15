# @routekit/tool-registry

The product-neutral, canonical registry of RouteKit coding-tool integrations.

```ts
import { toolRegistry } from "@routekit/tool-registry";

const integration = toolRegistry.get("codex");
```

The package owns the one runtime integration list used by RouteKit and by
products that compose RouteKit. To add a tool, add its package dependency and
one entry to `toolIntegrations` in `src/index.ts`; consumers do not maintain
parallel imports or lists.

## Docs

- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
