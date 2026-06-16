# Model-fusion protocol consumption

FusionKit remains the contract and IDL origin for model-fusion. Do not create a
separate protocol repository from HandoffKit. HandoffKit should consume stable
generated protocol artifacts instead of copying record shapes, schema lists,
service types, or schema bundle hashes by hand.

## Current TypeScript consumption path

- In this monorepo, import model-fusion records, validators, and constants from
  `@warrant/protocol`.
- Cross-repo TypeScript consumers should target the generated package name
  `@velum-labs/model-fusion-protocol` from GitHub Packages. This package should
  be generated from the FusionKit JSON Schema and OpenAPI 3.1 contracts.
- Service/API clients and request/response models should be generated from
  OpenAPI 3.1. The local HandoffKit snapshot currently generates
  `src/generated/model-fusion-openapi.ts` as a temporary compatibility surface.
- Durable record validators and record types should be generated from the JSON
  Schema bundle. HandoffKit continues to export its current model-fusion
  validators until FusionKit publishes the generated JSON Schema package.
- The package target is recorded in
  `../model-fusion-bindings.json` so CI can reject stale generated-binding
  configuration when the HTTP/OpenAPI compatibility snapshot changes.
- Producers must set `schema_bundle_hash` from the protocol package export
  `MODEL_FUSION_SCHEMA_BUNDLE_HASH`; they should not embed a local string copy.

## Python consumption path

GitHub Packages is not sufficient for Python package distribution. Python
consumers should use generated bindings from one of these private-package paths:

- Cloudsmith, AWS CodeArtifact, or Gemfury as the private PyPI-compatible index.
- Short-term bootstrap: publish wheels on GitHub Releases and consume them with
  `uv` URL dependencies.
- Short-term repo dependency: consume generated Python bindings with `uv` git
  dependencies pinned to a commit while the private index is being provisioned.
- Python service clients/models should be generated from OpenAPI 3.1, while
  Pydantic validators/models for durable records should be generated from the
  JSON Schema bundle.

## IDL and persisted records

- JSON Schema remains the durable persisted record and audit format.
- OpenAPI 3.1 is the v1 source of truth for HTTP/JSON service APIs.
- Protobuf/Buf is reserved for later internal streaming, Connect, or gRPC seams
  if the service boundary hardens; it is not required for v1 and is not part of
  this PR.
- The local OpenAPI document in
  `../openapi/model-fusion-harness-executor.openapi.json` is a consumer
  compatibility snapshot for the HandoffKit harness executor seam. Its canonical
  source belongs in FusionKit, and it should be replaced by generated package
  consumption when FusionKit publishes those packages.
- The compatibility snapshot captures the FusionKit -> HandoffKit HTTP boundary:
  `POST /v1/harness-executions` (`executeHarnessTask`).
- HTTP messages carry persisted JSON records as `PersistedJsonRecord`
  payloads with schema name, version, and schema bundle hash.

## Drift checks

The repository check runs `scripts/check-model-fusion-protocol.mjs` to guard the
local protocol snapshot:

- production code may not hardcode the model-fusion schema bundle hash outside
  `packages/protocol/src/model-fusion.ts`;
- the TypeScript package must export `MODEL_FUSION_SCHEMA_BUNDLE_HASH`;
- the local OpenAPI 3.1 compatibility snapshot must exist with the required
  HandoffKit harness executor operation;
- OpenAPI codegen output for TypeScript and Python must be regenerated and
  checked for drift;
- JSON Schema codegen for durable record validators belongs in FusionKit's
  generated package follow-up;
- the package target manifest must declare FusionKit as the canonical source,
  JSON Schema as the record source, OpenAPI 3.1 as the HTTP/service source, and
  protobuf as future-only;
- the published protocol metadata must match the TypeScript package name,
  Python package name `velum-model-fusion-protocol`, package version, schema
  bundle hash, and OpenAPI source hash;
- this document must retain the intended npm and Python publishing paths.

Follow-up work belongs in FusionKit/openclaw-shared: publish the canonical JSON
Schema bundle, OpenAPI 3.1 service contracts, and generated TypeScript/Python
packages. When HandoffKit can consume those packages, remove this compatibility
snapshot and update the check to verify the package version/source digest instead
of the local OpenAPI snapshot hash. Protobuf/Buf can be introduced later only for
internal streaming/Connect/gRPC boundaries if needed.
