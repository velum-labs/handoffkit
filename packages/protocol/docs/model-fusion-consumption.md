# Model-fusion protocol consumption

FusionKit remains the contract and IDL origin for shared model-fusion records.
HandoffKit consumes the published `@velum-labs/model-fusion-protocol` package
pinned at `0.1.0`; it must not treat copied schema lists, schema bundle hashes,
OpenAPI-generated clients, or durable record validators as canonical.

## TypeScript package consumption

- HandoffKit installs `@velum-labs/model-fusion-protocol@0.1.0` from GitHub
  Packages and re-exports the shared surface from `@warrant/protocol` for
  existing internal consumers.
- Durable model-fusion record types, validators, schema names, and
  `MODEL_FUSION_SCHEMA_BUNDLE_HASH` come from the published package.
- Generated TypeScript/OpenAPI/schema artifacts are consumed from the package.
  Local generated SDK mirrors such as `src/generated/model-fusion-openapi.ts`
  are not committed as canonical HandoffKit sources.
- Producers must set `schema_bundle_hash` from the package export
  `MODEL_FUSION_SCHEMA_BUNDLE_HASH`; they should not embed a local string copy.

## HandoffKit-owned service boundary

- The local document
  `../openapi/model-fusion-harness-executor.openapi.json` is the
  HandoffKit-owned harness executor OpenAPI contract for
  `POST /v1/harness-executions` (`executeHarnessTask`).
- This OpenAPI 3.1 contract describes HandoffKit's HTTP/JSON executor seam. It
  may include HandoffKit service API extensions, but its persisted JSON records
  still reference shared model-fusion schemas from
  `@velum-labs/model-fusion-protocol`.
- JSON Schema remains the durable persisted record and audit format.
- OpenAPI 3.1 is the v1 source of truth for HTTP/JSON service APIs.
- Protobuf/Buf is reserved for later internal streaming, Connect, or gRPC seams
  if the service boundary hardens; it is not required for v1.

## CI and local install authentication

GitHub Packages requires an auth token for the private
`@velum-labs/model-fusion-protocol` package:

- `.npmrc` maps the `@velum-labs` scope to `https://npm.pkg.github.com` and
  reads `NODE_AUTH_TOKEN` for package downloads.
- CI grants `packages: read` and sets `NODE_AUTH_TOKEN` to
  `secrets.MODEL_FUSION_PROTOCOL_NPM_TOKEN || secrets.GITHUB_TOKEN` during
  `pnpm install --frozen-lockfile`.
- If the repository-scoped `GITHUB_TOKEN` is not allowed to read the FusionKit
  package, configure `MODEL_FUSION_PROTOCOL_NPM_TOKEN` as a fine-grained token
  with read access to that GitHub Packages npm package.
- Local developers should export `NODE_AUTH_TOKEN` with an equivalent read token
  before running `pnpm install`.

## Drift checks

The repository check runs `scripts/check-model-fusion-protocol.mjs` to guard the
package-consumption boundary:

- root and protocol manifests must pin
  `@velum-labs/model-fusion-protocol@0.1.0`;
- the private package must be installed and expose the expected schema hash,
  schema names, validators, OpenAPI source hash, generated OpenAPI client, and
  TypeScript declaration metadata;
- HandoffKit's model-fusion facade and package entrypoint must re-export the
  shared protocol artifacts from the package;
- local generated OpenAPI SDK mirrors must remain absent;
- the HandoffKit-owned harness executor OpenAPI contract hash must match
  `../model-fusion-bindings.json`;
- committed compatibility fixtures, when present, must carry the package schema
  bundle hash;
- this document must retain the intended package, CI token, JSON Schema,
  OpenAPI, and Protobuf/Buf boundaries.

Follow-up changes to durable shared records or generated protocol package
artifacts belong in FusionKit/openclaw-shared and must be consumed by bumping the
published `@velum-labs/model-fusion-protocol` package version in HandoffKit.
