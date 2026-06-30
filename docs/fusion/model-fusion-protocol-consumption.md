# Model Fusion Protocol Consumption

FusionKit remains the contract and IDL origin for the model-fusion platform. Do not
copy contract shapes into HandoffKit, CursorKit, MLX provider integrations, or future
benchmark tooling. Consume a versioned protocol artifact from this repo instead.

## Artifact split

- JSON Schema in `spec/model-fusion-contract/schema/` is the persisted record and
  audit/benchmark format. Rows, receipts, artifacts, benchmark tasks, model calls,
  and harness results should continue to validate against these schemas.
- OpenAPI 3.1 in `spec/model-fusion-contract/openapi/` is the v1 HTTP/service API
  source of truth. It references the JSON Schema records instead of copying durable
  record fields.
- Protobuf/Buf is reserved for a later internal streaming, Connect, or gRPC boundary
  if the service boundary hardens. It is not required for v1 and is not part of this
  PR.

## Service boundaries

The initial IDL prepares these minimum service seams:

- `HarnessExecutorService`: FusionKit evals ask HandoffKit to execute coding tasks.
- `CursorHarnessService`: CursorKit maps adapter output into harness contract records.
- `MlxProviderService`: MLX provider adapters describe model capabilities and model-call
  metadata.
- `BenchmarkJoinService`: benchmark execution envelopes are joined into auditable row
  records.

## Package targets

TypeScript consumers should target the npm package name
`@velum-labs/model-fusion-protocol`, published to GitHub Packages while the repo remains
private. The package should contain JSON Schemas, OpenAPI 3.1, and generated
TypeScript SDK/types/validators. Service clients and request/response types are
generated from OpenAPI with `openapi-typescript` and `openapi-fetch`; durable record
validators are generated from the JSON Schema bundle with Ajv.

Python consumers need a private PyPI-compatible path. Prefer Cloudsmith, AWS
CodeArtifact, or Gemfury for private wheels. Short term, publish wheels to GitHub
Releases or pin `uv` git dependencies by commit. GitHub Packages is not enough for
private Python package consumption. Python repos should consume generated protocol
bindings from that package path rather than copying Pydantic or JSON Schema shapes.
The Python package exposes generated OpenAPI operation metadata/client scaffolding
and JSON Schema validators generated from the durable record bundle.

Release automation and required secrets are documented in
`docs/model-fusion-protocol-release.md`.

## CI drift checks

CI should run:

```bash
uv run python scripts/validate_contract_fixtures.py
uv run python scripts/validate_protocol_package.py
uv run pytest
```

When generated SDK output is committed or published from CI, add a generation drift
check such as:

```bash
npm --prefix spec/model-fusion-contract ci
npm --prefix spec/model-fusion-contract run check:generated
```

The first two checks ensure JSON Schema fixture hashes, package metadata, required
service paths, OpenAPI 3.1 versioning, and JSON Schema references do not drift. The
generated-code check regenerates OpenAPI clients/types and JSON Schema validators,
then fails if the committed outputs drift.

## Correction from earlier proto-first direction

An earlier scaffold treated protobuf/Buf as the service/SDK source. The v1 direction
is now JSON Schema for durable records plus OpenAPI 3.1 for HTTP/JSON service APIs.
This PR removes the proto/Buf v1 path and keeps protobuf as future-facing only.

## Follow-up outside this PR

- HandoffKit should replace any copied protocol models with generated OpenAPI
  `HarnessExecutorService` bindings and generated JSON Schema validators from the
  package.
- CursorKit should emit `CursorHarnessService` records through generated OpenAPI
  bindings and keep Cursor-specific persisted records validated by generated JSON
  Schema validators.
- MLX provider integrations should consume `MlxProviderService` bindings for
  provider metadata instead of cloning FusionKit types.
- Release automation should publish the npm package and a private Python wheel from
  this FusionKit contract origin, generated from JSON Schema and OpenAPI.
