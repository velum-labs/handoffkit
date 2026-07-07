# fusionkit docs

The production documentation site for fusionkit, built with
[Fumadocs](https://fumadocs.dev) (Next.js App Router). It covers the
`@fusionkit/cli` product and the Python fusion engine behind it. It is
published at `fusionkit.velum-labs.com`.

This is a **standalone app**: like `apps/scope`, it is not part of the root
`packages/*` + `examples/*` pnpm workspace, so its UI dependency tree stays out
of the governed core's frozen lockfile and trust surface. It has its own
`pnpm-workspace.yaml` and is installed/built on its own.

## Develop

```bash
cd apps/docs
pnpm install
pnpm dev:app    # http://localhost:4318  (or `pnpm dev` for the portless proxy)
```

`fumadocs-mdx` runs on install/dev/build to generate the `.source` content index.

## Build

```bash
pnpm build
pnpm start
```

## Content

Docs live in `content/docs/**/*.mdx`, grouped into folder-based sidebar sections,
each ordered by its own `meta.json` (and the root `content/docs/meta.json`).
The sidebar is organized by reader intent:

- **Get started**: installation and the quickstart.
- **Tools**: one page per supported coding agent (Codex, Claude Code, Cursor).
- **Guides**: workflow guides for the inference endpoint, rate-limit handoff,
  cost control, observability, troubleshooting, and examples.
- **Concepts**: mental models for model fusion, the runtime kernel, product
  scope, and privacy.
- **Reference**: the command reference, `.fusionkit/` configuration, models and
  panels, and the package map.
- **API reference**: runtime route overview plus generated contract reference.
- **Changelog**: release notes, generated from the repo-root `CHANGELOG.md` by
  `scripts/sync-docs-changelog.mjs` (runs on every dev/build; the release
  coordinator regenerates it in each release commit, and `pnpm check` at the
  repo root fails when it drifts).

When a page moves between sections, add a permanent redirect in
`next.config.mjs` so deployed URLs keep working.

Mermaid code blocks render as diagrams (via `remarkMdxMermaid` plus the
client-side `components/mermaid.tsx`).

## API reference (OpenAPI)

The API reference is generated from the model-fusion OpenAPI contract:

```bash
pnpm generate:openapi   # emits MDX into content/docs/api from
                        # packages/protocol/openapi/model-fusion-harness-executor.openapi.json
```

Commit the generated MDX and rebuild. Regenerate whenever the contract changes.
The pages render through `APIPage` (wired in `mdx-components.tsx` via
`lib/openapi.ts`).

## Deploy (Vercel)

The site deploys as its own Vercel project:

- **Root Directory**: `apps/docs` (Vercel checks out the full repo, so the
  OpenAPI source path resolves; the generated MDX is committed, so the build does
  not depend on regeneration).
- **Framework preset**: Next.js. Install/build commands and security headers are
  declared in [`vercel.json`](./vercel.json) (`pnpm install` / `pnpm build`).
- **Node**: 22 (pinned via `engines` in `package.json`).
- **Previews**: every PR gets an automatic preview deployment once the repo is
  linked.
- **Custom domain**: `fusionkit.velum-labs.com`, configured in the Vercel
  project (also update `metadataBase` in `app/layout.tsx` if the domain changes).

First-time setup:

```bash
npm i -g vercel
cd apps/docs
vercel link          # create/link the project (set Root Directory to apps/docs)
vercel --prod        # or push to the default branch once Git is connected
```

## Version pinning note

The fumadocs packages are pinned to exact versions (`fumadocs-core`,
`fumadocs-mdx`, `fumadocs-ui`, `fumadocs-openapi`) for reproducible builds.
`lib/source.ts` resolves fumadocs-mdx's lazy `files()` factory into the array
shape fumadocs-core 15.x expects; revisit that shim if you upgrade to fumadocs
v16.
