# Release publishing

For repository security controls, evidence requirements, incident runbooks, and
rollback rehearsal, see [RouteKit release security](release-security.md) and
[Release rollback](release-rollback.md).

HandoffKit publishes the RouteKit foundation (`@routekit/*`, including the
`routekit` CLI) and FusionKit product packages (`@fusionkit/*`, including the
`fusionkit` CLI) to the public npm registry only from the canonical repository.

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

Use one release tag, not two. `handoffkit-v<version>` is the canonical tag
created by the release coordinator; the workflow still accepts the historical
`v<version>` form for an older release, but a release does not need both tags.

The workflow job is guarded with:

```yaml
if: github.repository == 'velum-labs/handoffkit'
```

Forks and non-canonical mirrors cannot publish packages through this workflow.

## Published packages

The complete publish list and explicit dependency order live in
`release/npm-packages.json`. `@routekit/cli` installs `routekit`;
`@fusionkit/cli` installs `fusionkit`. Packages publish under both
`@routekit/*` and `@fusionkit/*` to:

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

## Authentication: trusted publishing

Publishing uses **npm trusted publishing (OIDC)** with no stored token.
The workflow already grants `id-token: write` and updates the npm CLI to a
version that performs the OIDC exchange, so once a Trusted Publisher is
configured on npmjs.com, `npm publish` authenticates via OIDC automatically
(and provenance is generated automatically).

Every package in both scopes must configure *Settings → Trusted Publisher* with
organization `velum-labs`, repository `handoffkit`, workflow filename
`release-packages.yml`, and no environment. The workflow intentionally does not
set `registry-url`, `NODE_AUTH_TOKEN`, or an npm auth line: any token entry can
shadow OIDC.

Workflow permissions: `id-token: write` (OIDC + provenance) and
`contents: read` (checkout).

## Release validation

Every release run performs:

```bash
corepack pnpm install --frozen-lockfile
node scripts/check-release-publish.mjs
corepack pnpm check
corepack pnpm build
node scripts/check-routekit-cli-pack.mjs
corepack pnpm --dir apps/scope install --frozen-lockfile
corepack pnpm --dir apps/scope build
node scripts/stage-scope.mjs
node scripts/check-fusionkit-cli-pack.mjs --require-scope
corepack pnpm test
```

The strict FusionKit pack smoke proves the tarball contains
`scope/server.js`. Ordinary source-checkout pack smokes remain valid without a
staged dashboard, but verify it whenever `packages/cli/scope/server.js` is
present.

`scripts/check-release-publish.mjs` verifies:

- canonical repository and tag patterns;
- public npm registry, public access, and provenance settings;
- dependency-ordered package metadata, LICENSE/files/provenance fields, and the
  `routekit`/`fusionkit` bins for every publishable workspace;
- the `@fusionkit/cli` Scope directory declaration and release-stage ordering;
- both clean-install package-closure smokes;
- all five PyPI release packages plus the required `fusionkit-sidecar` and
  `fusionkit-bench` binaries and forbidden Python `fusionkit` executable;
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

`.github/workflows/pypi-release.yml` publishes the internal Fusion sidecar
runtime in dependency order (`fusionkit-core`, `fusionkit-server`, `fusionkit`)
followed by `fusionkit-mlx` and `fusionkit-evals`. It verifies the wheels install
`fusionkit-sidecar` and `fusionkit-bench` but no Python `fusionkit` executable.
All five projects use PyPI Trusted Publishers after any one-time project
bootstrap.

The separate protocol Python package is published by
`.github/workflows/model-fusion-protocol-release.yml`.
