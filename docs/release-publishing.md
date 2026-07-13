# Release publishing

HandoffKit publishes its TypeScript workspace packages to the public npm
registry (the `fusionkit` CLI plus the `@fusionkit/*` libraries it depends on)
only from the canonical repository.

> For cutting releases across the whole velum-labs workspace (handoffkit,
> cursorkit, fusionkit, mlx-lm) with the Terraform-style `plan`/`apply`
> coordinator, see [releasing.md](releasing.md). This document covers
> handoffkit's own npm publish workflow, which that coordinator triggers.

## Triggers

The release workflow is `.github/workflows/release-packages.yml`.

- Publishing runs on a **published GitHub Release** (`release: published`), and
  only when the release's tag matches `handoffkit-v*` or `v*`.
- `workflow_dispatch` runs a dry-run pack only; it never publishes.

Draft a GitHub Release against a `handoffkit-v<version>` tag, review the notes,
and publishing happens when you click **Publish release**. A bare tag push does
not publish.

The workflow job is guarded with:

```yaml
if: github.repository == 'velum-labs/handoffkit'
```

Forks and non-canonical mirrors cannot publish packages through this workflow.

## Published packages

The publish list and order live in `release/npm-packages.json`. The CLI
publishes as `@fusionkit/cli` (its bin is `fusionkit`); its libraries publish
under the `@fusionkit/*` scope. Packages are published to:

```text
https://registry.npmjs.org
```

Each publishable package must set:

```json
{
  "private": false,
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public",
    "provenance": true
  }
}
```

Packages not listed in `release/npm-packages.json` must remain `private: true`.

## Authentication: trusted publishing (with one-time token bootstrap)

The target steady state is **npm trusted publishing (OIDC)** with no stored token.
The workflow already grants `id-token: write` and updates the npm CLI to a
version that performs the OIDC exchange, so once a Trusted Publisher is
configured on npmjs.com, `pnpm publish` authenticates via OIDC automatically
(and provenance is generated automatically).

npm has one catch: a Trusted Publisher can only be attached to a package that
**already exists**, so the very first publish of new packages cannot use OIDC.
The bootstrap flow is therefore:

1. **First release with token.** Add an `NPM_TOKEN` repository secret (a granular
   token scoped to the `@fusionkit` scope with write access, short expiry). The
   first published GitHub Release creates all packages on npm. `NPM_TOKEN` is
   written to `~/.npmrc` only on `release` events; `workflow_dispatch` packs a
   dry-run and never needs it.
2. **Configure Trusted Publishers.** On each package's
   *Settings → Trusted Publisher* set org `velum-labs`, repository `handoffkit`,
   workflow filename `release-packages.yml`, environment blank.
3. **Drop the token.** Remove the `NPM_TOKEN` secret. Subsequent releases use
   OIDC; the workflow needs no other change (the token step is a no-op without
   the secret, and `pnpm publish` prefers OIDC when a Trusted Publisher exists).

Workflow permissions: `id-token: write` (OIDC + provenance) and
`contents: read` (checkout).

## Release validation

Every release run performs:

```bash
corepack pnpm install --frozen-lockfile
node scripts/check-release-publish.mjs
corepack pnpm check
corepack pnpm build
corepack pnpm test
```

`scripts/check-release-publish.mjs` verifies:

- canonical repository and tag patterns;
- public npm registry, public access, and provenance settings;
- package metadata for every publishable workspace;
- model-fusion OpenAPI snapshot hash and protocol package version;
- generated TypeScript and Python OpenAPI client/model drift.

`scripts/check-model-fusion-protocol.mjs` separately verifies that v1 protocol
packaging stays on JSON Schema durable records plus OpenAPI 3.1 HTTP/API
contracts, and that protobuf/Buf is not required for v1.

`scripts/check-generated-model-fusion-sdk.mjs` regenerates the temporary
OpenAPI-derived TypeScript and Python SDK surfaces and fails if checked-in
generated files differ. Durable record validators should come from JSON Schema
codegen in the canonical FusionKit package; HandoffKit exports its current
validators until that generated package is available.

## Python packages

This repository's release workflow is npm-only. The protocol's Python package
is published by `.github/workflows/model-fusion-protocol-release.yml`, which
uploads to a private PyPI-compatible registry (Cloudsmith, AWS CodeArtifact,
Gemfury, or equivalent) via the secrets `PRIVATE_PYPI_URL`,
`PRIVATE_PYPI_USERNAME`, and `PRIVATE_PYPI_PASSWORD`. If those secrets are
absent, the workflow builds wheel/sdist artifacts and attaches them to a GitHub
Release instead of publishing to public PyPI.
