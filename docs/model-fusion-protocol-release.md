# Model Fusion Protocol Release

FusionKit is the v1 origin for the model-fusion protocol bundle. Release automation
(`.github/workflows/model-fusion-protocol-release.yml`) is intentionally scoped to
the protocol package.

## Tag pattern

Publish a protocol release by pushing an explicit tag:

```bash
git tag model-fusion-protocol-v0.1.0
git push origin model-fusion-protocol-v0.1.0
```

Only tags matching `model-fusion-protocol-v*` trigger publishing. Manual
`workflow_dispatch` runs are dry-run/build validation and do not publish.

## Canonical repository guard

The workflow is guarded with:

```yaml
if: github.repository == 'velum-labs/handoffkit'
```

Forks and non-canonical repositories do not publish packages.

## Published artifacts

The release workflow:

1. Runs contract validators, tests, Ruff, and Pyright.
2. Installs pinned protocol code generators with `npm ci`.
3. Regenerates OpenAPI clients/types and JSON Schema validators, then fails if
   committed generated outputs drift.
4. Validates npm package contents with `npm pack --dry-run`.
5. Builds the Python `velum-model-fusion-protocol` wheel and sdist using
   `scripts/build_protocol_python_package.py`, which stages JSON Schema/OpenAPI
   assets into the package build tree without committing duplicate contract copies.
6. Publishes `@velum-labs/model-fusion-protocol` to public npm
   (`registry.npmjs.org`) with `npm publish --access public --provenance`; the
   package's `publishConfig` in `spec/model-fusion-contract/package.json` pins
   the public registry, public access, and provenance.
7. Publishes Python artifacts to a private PyPI-compatible registry when configured.
8. Falls back to attaching Python wheel/sdist files to the GitHub Release when private
   registry secrets are absent.

The Python fallback is intentional and safe: it preserves release artifacts for
private distribution when no private registry is configured.

## Required secrets

npm publishing authenticates with the `NPM_TOKEN` repository secret
(`NODE_AUTH_TOKEN` in the publish step). The workflow grants `id-token: write`
and updates the npm CLI so OIDC trusted publishing works once a Trusted
Publisher is configured on npmjs.com (see
[release-publishing.md](release-publishing.md) for the token-bootstrap flow).

For private Python publishing, configure all of:

- `PRIVATE_PYPI_URL`: upload endpoint for Cloudsmith, AWS CodeArtifact, Gemfury, or
  another private PyPI-compatible registry.
- `PRIVATE_PYPI_USERNAME`: registry username or token username.
- `PRIVATE_PYPI_PASSWORD`: registry password or token value.

If any private PyPI secret is missing, the workflow does not upload to public PyPI
and instead attaches the Python distributions to the GitHub Release.

## Release validation

The workflow runs:

```bash
uv run python scripts/validate_contract_fixtures.py
uv run python scripts/validate_protocol_package.py
npm --prefix spec/model-fusion-contract ci
npm --prefix spec/model-fusion-contract run check:generated
uv run pytest
uv run ruff check .
uv run pyright
```

`validate_protocol_package.py` checks:

- npm package name, public npm registry/access settings, and generation scripts;
- Python package name/version and bundled contract assets;
- package/OpenAPI/Python versions match;
- OpenAPI 3.1 schema bundle hash matches the JSON Schema bundle;
- required v1 service paths and tags exist;
- protobuf/Buf is not part of the required v1 release path.

The generated-code check uses `openapi-typescript` and `openapi-fetch` for
TypeScript OpenAPI client/types, and repo-local generation for JSON Schema validator
indexes plus Python OpenAPI operation metadata/client scaffolding. Consumers should
use these generated outputs rather than copying service interfaces or record shapes.

## Scope

Existing FusionKit Python workspace packages are not published by this workflow;
they ship through their own release automation (see
[releasing.md](releasing.md)). The protocol package remains the priority release
artifact for cross-repo consumption.
