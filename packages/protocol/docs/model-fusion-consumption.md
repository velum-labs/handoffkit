# Model-fusion protocol consumption

FusionKit remains the contract and IDL origin for model-fusion. Do not create a
separate protocol repository from HandoffKit. HandoffKit should consume stable
generated protocol artifacts instead of copying record shapes, schema lists,
service types, or schema bundle hashes by hand.

## Current TypeScript consumption path

- In this monorepo, import model-fusion records, validators, and constants from
  `@warrant/protocol`.
- Cross-repo TypeScript consumers should target the generated package name
  `@velum/model-fusion-protocol` once FusionKit publishes it to npm or GitHub
  Packages. This package should be generated from the FusionKit Buf/protobuf
  source.
- The package target is recorded in
  `../model-fusion-bindings.json` so CI can reject stale generated-binding
  configuration when the service proto changes.
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

## IDL and persisted records

- JSON Schema remains the durable persisted record and audit format.
- Protobuf/Buf is the source of truth for service and SDK boundaries.
- OpenAPI, if needed, must be generated from the Buf/protobuf source. Do not
  hand-author OpenAPI for model-fusion boundaries in HandoffKit.
- The local IDL in `../proto/model_fusion/v1/services.proto` is a consumer
  compatibility snapshot only. Its canonical source belongs in FusionKit, and it
  should be replaced by generated package consumption when FusionKit publishes
  those packages.
- The compatibility snapshot captures the minimum cross-repo boundaries:
  - `HarnessExecutorService` for FusionKit -> HandoffKit coding task execution.
  - `CursorHarnessService` for CursorKit adapter output.
  - `MlxProviderService` for provider capability and model-call metadata.
  - `BenchmarkExecutionService` for FusionKit eval execution and join envelopes.
- Service messages carry persisted JSON records as `PersistedJsonRecord`
  payloads with schema name, version, and schema bundle hash.

## Drift checks

The repository check runs `scripts/check-model-fusion-protocol.mjs` to guard the
local protocol snapshot:

- production code may not hardcode the model-fusion schema bundle hash outside
  `packages/protocol/src/model-fusion.ts`;
- the TypeScript package must export `MODEL_FUSION_SCHEMA_BUNDLE_HASH`;
- the Buf module, local compatibility snapshot, and service-boundary IDL must
  exist with the required service names;
- the package target manifest must declare FusionKit as the canonical source,
  Buf/protobuf as the service/SDK source, and OpenAPI as generated-only;
- this document must retain the intended npm and Python publishing paths.

Follow-up work belongs in FusionKit/openclaw-shared: publish the canonical Buf
module, generate OpenAPI from it if an HTTP description is needed, and publish
the generated TypeScript and Python packages. When HandoffKit can consume those
packages, remove this compatibility snapshot and update the check to verify the
package version/source digest instead of the local proto hash.
