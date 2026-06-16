# Model-fusion protocol consumption

FusionKit remains the contract and IDL origin for model-fusion until there is a
strong reason to split a separate protocol repository. HandoffKit should consume
stable protocol artifacts and validators instead of copying record shapes,
schema lists, or schema bundle hashes by hand.

## Current TypeScript consumption path

- In this monorepo, import model-fusion records, validators, and constants from
  `@warrant/protocol`.
- Cross-repo TypeScript consumers should target the generated package name
  `@velum/model-fusion-protocol` once FusionKit publishes it to npm or GitHub
  Packages.
- The package target is recorded in
  `../model-fusion-bindings.json` so CI can reject stale generated-binding
  configuration when the service proto changes.
- Producers must set `schema_bundle_hash` from the protocol package export
  `MODEL_FUSION_SCHEMA_BUNDLE_HASH`; they should not embed a local string copy.

## Python consumption path

GitHub Packages is not sufficient for Python package distribution. Python
consumers should use one of these private-package paths:

- Cloudsmith, AWS CodeArtifact, or Gemfury as the private PyPI-compatible index.
- Short-term bootstrap: publish wheels on GitHub Releases and consume them with
  `uv` URL dependencies.
- Short-term repo dependency: consume generated Python bindings with `uv` git
  dependencies pinned to a commit while the private index is being provisioned.

## IDL and persisted records

- JSON Schema remains the durable persisted record and audit format.
- Protobuf/Buf IDL is for service and transport boundaries only.
- The seed IDL in `../proto/model_fusion/v1/services.proto` captures the minimum
  cross-repo boundaries:
  - `HarnessExecutorService` for FusionKit -> HandoffKit coding task execution.
  - `CursorHarnessService` for CursorKit adapter output.
  - `MlxProviderService` for provider capability and model-call metadata.
  - `BenchmarkExecutionService` for FusionKit eval execution and join envelopes.
- Transport messages carry persisted JSON records as `PersistedJsonRecord`
  payloads with schema name, version, and schema bundle hash.

## Drift checks

The repository check runs `scripts/check-model-fusion-protocol.mjs` to guard the
local protocol snapshot:

- production code may not hardcode the model-fusion schema bundle hash outside
  `packages/protocol/src/model-fusion.ts`;
- the TypeScript package must export `MODEL_FUSION_SCHEMA_BUNDLE_HASH`;
- the Buf module and service-boundary IDL must exist with the required service
  names;
- this document must retain the intended npm and Python publishing paths.

When generated TS or Python bindings are checked in, add their generation command
to this check so CI fails if regenerated output differs from source IDL. The
binding target manifest already pins the proto source hash and package registry
targets for that future generated output.
