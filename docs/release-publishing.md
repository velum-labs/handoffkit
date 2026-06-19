# Release publishing

HandoffKit publishes its TypeScript workspace packages to the public npm
registry (the `fusionkit` CLI plus the `@fusionkit/*` libraries it depends on)
only from the canonical repository.

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

## Required credentials

The workflow needs an `NPM_TOKEN` repository secret (an npm automation token
with publish rights to the `@fusionkit` scope). Permissions:

- `id-token: write` for npm provenance (OIDC).
- `contents: read` for checkout.

`NPM_TOKEN` is written to `~/.npmrc` for `registry.npmjs.org` only on tag
pushes; `workflow_dispatch` runs a dry-run pack and never needs it.

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

This repository's release workflow is npm-only. If HandoffKit later adds a
Python package, publish it to a private PyPI-compatible registry (Cloudsmith,
AWS CodeArtifact, Gemfury, or equivalent) via explicit secrets such as
`PRIVATE_PYPI_REPOSITORY_URL`, `PRIVATE_PYPI_USERNAME`, and
`PRIVATE_PYPI_PASSWORD`. If those secrets are absent, the workflow should build
wheel/sdist artifacts and attach them to a GitHub Release instead of publishing
to public PyPI.
