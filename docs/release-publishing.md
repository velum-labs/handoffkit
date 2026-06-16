# Release publishing

HandoffKit publishes internal TypeScript workspace packages to GitHub Packages
only from the canonical repository.

## Triggers

The release workflow is `.github/workflows/release-packages.yml`.

- `handoffkit-v*` tags publish packages.
- `v*` tags publish packages.
- `workflow_dispatch` runs a dry-run pack only; it never publishes.

The workflow job is guarded with:

```yaml
if: github.repository == 'velum-labs/handoffkit'
```

Forks and non-canonical mirrors cannot publish packages through this workflow.

## Published packages

The publish list and order live in `release/npm-packages.json`. Packages are
published to:

```text
https://npm.pkg.github.com
```

Each publishable package must set:

```json
{
  "private": false,
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "restricted",
    "provenance": true
  }
}
```

Packages not listed in `release/npm-packages.json` must remain `private: true`.

## Required credentials

No repository secret is required for the npm path. The workflow uses the
repository-scoped `GITHUB_TOKEN` with:

- `packages: write` to publish to GitHub Packages.
- `id-token: write` for npm provenance.
- `contents: read` for checkout.

Do not add public npm tokens to this workflow. Publishing to the public npm
registry is intentionally not configured.

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
- GitHub Packages registry, restricted access, and provenance settings;
- package metadata for every publishable workspace;
- model-fusion OpenAPI snapshot hash and protocol package version.

`scripts/check-model-fusion-protocol.mjs` separately verifies that v1 protocol
packaging stays on JSON Schema durable records plus OpenAPI 3.1 HTTP/API
contracts, and that protobuf/Buf is not required for v1.

## Python packages

This repository's release workflow is npm-only. If HandoffKit later adds a
Python package, publish it to a private PyPI-compatible registry (Cloudsmith,
AWS CodeArtifact, Gemfury, or equivalent) via explicit secrets such as
`PRIVATE_PYPI_REPOSITORY_URL`, `PRIVATE_PYPI_USERNAME`, and
`PRIVATE_PYPI_PASSWORD`. If those secrets are absent, the workflow should build
wheel/sdist artifacts and attach them to a GitHub Release instead of publishing
to public PyPI.
