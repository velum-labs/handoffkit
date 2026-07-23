# Release publishing

HandoffKit publishes the RouteKit foundation (`@velum-labs/routekit` and `@velum-labs/routekit-*`, including the
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
`release/npm-packages.json`. `@velum-labs/routekit` installs `routekit`;
`@fusionkit/cli` installs `fusionkit`. Packages publish as
`@velum-labs/routekit`, `@velum-labs/routekit-*`, and `@fusionkit/*` to:

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

Normal publishing uses **npm trusted publishing (OIDC)** with no stored token.
The workflow already grants `id-token: write` and updates the npm CLI to a
version that performs the OIDC exchange, so once a Trusted Publisher is
configured on npmjs.com, `npm publish` authenticates via OIDC automatically
(and provenance is generated automatically).

Every package must configure *Settings → Trusted Publisher → GitHub Actions*
with organization `velum-labs`, repository `handoffkit`, workflow filename
`release-packages.yml`, no environment, and `npm publish` as an allowed action.
The normal workflow path intentionally does not set `registry-url` or write an
npm auth line: either can shadow OIDC.

Workflow permissions: `id-token: write` (OIDC + provenance) and
`contents: read` (checkout).

### One-time bootstrap for new package names

npm cannot attach a Trusted Publisher until a package exists. For the first
release containing new names:

1. Create a short-lived granular npm token with publish access to the
   `@velum-labs` and `@fusionkit` organizations and CI/2FA bypass enabled.
2. Store it as the `NPM_TOKEN` repository secret. The release workflow writes a
   private, temporary npm user config only when that secret is non-empty.
3. Publish the reviewed GitHub Release. The publisher checks every exact
   package version before upload, so rerunning a partially completed workflow
   skips immutable versions that already reached npm.
4. Configure the Trusted Publisher above on every newly created package.
5. Delete `NPM_TOKEN` immediately. Subsequent releases use OIDC exclusively.

If publication fails partway through the manifest, rerun the failed GitHub
Actions job after correcting the cause. Do not create another release or bump
the version merely to recover the remaining packages. `workflow_dispatch`
remains a pack-only dry run and never publishes.

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
