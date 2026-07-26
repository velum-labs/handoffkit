# RouteKit

RouteKit (`@velum-labs/routekit` and `@velum-labs/routekit-*`) is maintained in a
separate repository:

**https://github.com/velum-labs/routekit**

Handoffkit (FusionKit) consumes the published npm packages. To develop against a
local sibling checkout:

```bash
pnpm run dev:link-routekit-src
pnpm install
```

Restore published pins with:

```bash
pnpm run dev:link-routekit-src -- --unlink
pnpm install
```
