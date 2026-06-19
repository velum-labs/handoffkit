# fusionkit docs

The documentation site for `@fusionkit/cli`, built with [Fumadocs](https://fumadocs.dev)
(Next.js App Router).

This is a **standalone app**: like `apps/scope`, it is not part of the root
`packages/*` + `examples/*` pnpm workspace, so its UI dependency tree stays out
of the governed core's frozen lockfile and trust surface. It has its own
`pnpm-workspace.yaml` and is installed/built on its own.

## Develop

```bash
cd apps/docs
pnpm install
pnpm dev        # http://localhost:4318
```

`fumadocs-mdx` runs on install/dev/build to generate the `.source` content index.

## Build

```bash
pnpm build
pnpm start
```

## API reference (OpenAPI)

The API reference is generated from the model-fusion OpenAPI contract:

```bash
pnpm generate:openapi   # emits MDX into content/docs/api from
                        # packages/protocol/openapi/model-fusion-harness-executor.openapi.json
```

Commit the generated MDX and rebuild. Regenerate whenever the contract changes.

## Content

Docs live in `content/docs/*.mdx`, ordered by `content/docs/meta.json`:

- Getting Started, Installation, Quickstart
- Configuration (`fusionkit.json`), Cost & Models
- Observability, Troubleshooting, Architecture, API Reference
