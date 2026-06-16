# ENG-596 microVM design spike and migration plan

Date: 2026-06-16
Status: Implemented for the opt-in Vercel Sandbox path

Design note: this document closes MF-61. It evaluates the path from ENG-595's
candidate container hardening to a Firecracker-backed microVM runtime without
replacing the Phase 2 worktree/container path. The public API recommendation is
to preserve the ComputeSDK-shaped surface in `@warrant/adapter-compute` while
moving the underlying isolation tier toward Vercel Sandbox first.

## Recommendation

Use Vercel Sandbox as the first microVM substrate for candidate and compute
sandbox hardening. Keep the app-facing shape stable:

```ts
const compute = governedCompute({ workspace, plane, pool, session: "vercel-sandbox" });
const sandbox = await compute.sandbox.create();
await sandbox.runCommand("npm test");
```

The migration should change the runner/session substrate behind that shape, not
the caller's mental model. Raw Firecracker remains a later path for customers
that require self-hosted isolation or deeper attestation control.

## Comparison

| Option | Isolation | Startup/cache story | Network policy | Secret story | Receipt impact | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| Current process/worktree | OS process + git worktree | Fastest, already used | Advisory proxy only | Brokered env can be injected, but host process is weaker | Stable receipts | Keep as default fallback and demo path |
| ENG-595 container driver | Container per candidate | Local image cache, no CI requirement | Deny-all via Docker/Podman; allowlist requires custom driver | Brokered env only, metadata scan only | Metadata-only hardening record | Keep as Phase 2 hardening bridge |
| Vercel Sandbox | Firecracker microVM | Runtime images, Git/tarball/snapshot source, `persistent: false`, sandbox snapshots for warm cache | Platform firewall: allow-all, deny-all, or allowed domains | Brokered env only; host env fallback suppressed by session harness auth patterns | Stable governed receipts using `vercel-sandbox`; model-fusion metadata for candidate hardening | Recommended first microVM path |
| Raw Firecracker | Self-hosted microVM | Full control, but image/snapshot/cni lifecycle is ours | Full control, high implementation burden | Full control, high broker integration burden | Potential new attestation/cleanup events | Defer until self-hosting or attestation demand is explicit |

## Runtime model

### Snapshot and clone

For governed sessions, Vercel Sandbox can launch from an empty runtime, Git
source, tarball source, or snapshot. Candidate runs should default to
`persistent: false` so a candidate VM does not auto-resume stale state. Warm
startup should use sandbox snapshots after dependency/bootstrap install.

The `<30s` overhead target is a warm-cache target:

- Cold path: create sandbox, stage workspace, install/bootstrap as needed, run.
- Warm path: create from snapshot, stage only task/workspace delta, run.
- Cache path: mount dependency/cache drives read-only when supported.

### Filesystem

The candidate workspace remains the writable layer. Dependency caches and shared
tool caches should be mounted read-only. Ignore `.git`, `node_modules`, and
`.warrant` by default when staging/mirroring, matching the existing
`session-vercel-sandbox` helpers and ENG-595 hardening metadata.

Mirror-back should remain runner-owned: the sandbox can produce files, but the
runner computes output diffs and artifacts. The model or harness should never be
trusted to declare what changed.

### Network

Map Warrant `NetworkPolicy` to the sandbox firewall:

- `defaultDeny: false` -> `allow-all`
- `defaultDeny: true` and no allowlist -> `deny-all`
- `defaultDeny: true` with allowlist -> allowed-domain policy

If the selected backend cannot enforce the requested allowlist, it must fail
closed. This matches ENG-595's container-driver behavior.

### Secrets

Secrets stay brokered. The contract names requested secrets; approval releases
values to the runner; the runtime receives explicit env values only for the
session. Records may include secret names, env names, and value hashes, but
never raw values.

### Cleanup

Candidate microVM runs must record create/stop/delete or equivalent cleanup
status. For Vercel Sandbox, `sandbox.stop()` is the minimum cleanup signal.
Later production hardening should add orphan scanning by tags and retention TTL.

## Compute adapter migration

`@warrant/adapter-compute` keeps the right public shape for sandbox workflows:
`sandbox.create()`, filesystem methods, and `runCommand()` over governed
sessions. The implemented names are:

- `CommandHarnessConfig.session?: SessionIsolation` in `@warrant/handoff`
- `GovernedComputeConfig = CommandHarnessConfig` in
  `@warrant/adapter-compute`
- `governedCompute({ ..., session: "vercel-sandbox" })`
- `withCompute(h, { pool, session: "vercel-sandbox" })`
- `SandboxRunRecord.isolation`, derived from `receipt.runner.isolation`

Each command still creates one signed contract, waits for one governed run,
pulls output when requested, and verifies the receipt bundle offline. The
session option only requests the runner isolation tier; it does not change the
ComputeSDK-shaped caller surface.

## Measurement plan

The executable measurement lives in `examples/microvm-isolation-bench`. It
always measures CI-safe local phases and only runs live Vercel Sandbox when
explicitly requested.

Build first, then run the default credential-free measurement with the root
script:

```sh
pnpm build
WARRANT_MICROVM_LIVE=0 pnpm microvm:bench
```

Default no-credential run reports:

- local workspace file discovery/staging input size
- ENG-595 process and fake-container command overhead
- secret/artifact scan overhead
- `@warrant/adapter-compute` governed sandbox command overhead on the local
  test stack
- governed Vercel Sandbox, direct live substrate, and warm snapshot sections as
  `SKIP` unless live mode and credentials are present

Live run requirements:

- `WARRANT_MICROVM_LIVE=1`
- Vercel credentials available via local env or OIDC
- optional `WARRANT_MICROVM_SNAPSHOT_ID` for warm snapshot startup measurement

Live command forms:

```sh
pnpm build
WARRANT_MICROVM_LIVE=1 pnpm microvm:bench
WARRANT_MICROVM_LIVE=1 WARRANT_MICROVM_SNAPSHOT_ID=snap_... pnpm microvm:bench
```

Observed no-live smoke output with `WARRANT_MICROVM_BENCH_FILES=5` and
`WARRANT_MICROVM_BENCH_ITERS=1`:

```text
microvm isolation bench: 5 files, 1 iterations

local path:
  [OK ] workspace file count             p50=6.0 p95=6.0 files
  [OK ] workspace staged bytes           p50=151.0 p95=151.0 bytes
  [OK ] file discovery                   p50=0.2 p95=0.2 ms (p95 budget 30000 ms)
  [OK ] process isolation command        p50=8.6 p95=8.6 ms (p95 budget 30000 ms)
  [OK ] fake container command           p50=0.4 p95=0.4 ms (p95 budget 30000 ms)
  [OK ] secret absence scan              p50=0.2 p95=0.2 ms (p95 budget 30000 ms)

governed compute path:
  [OK ] compute sandbox command          p50=1383.7 p95=1383.7 ms (p95 budget 30000 ms)
  [SKIP] governed vercel-sandbox command  set WARRANT_MICROVM_LIVE=1

direct live substrate path:
  [SKIP] direct vercel sandbox cold       set WARRANT_MICROVM_LIVE=1

warm snapshot path:
  [SKIP] direct vercel sandbox warm snapshot set WARRANT_MICROVM_LIVE=1

target: warm microVM overhead <30000 ms
note: governed live uses session="vercel-sandbox"; direct live is raw substrate timing
```

This output proves local measurement mechanics, existing compute overhead, and
CI-safe skip behavior. It does not prove live `<30s` microVM overhead unless the
governed and direct live sections run with credentials, and the warm path runs
with `WARRANT_MICROVM_SNAPSHOT_ID`.

## Receipt compatibility

Stable fields:

- `RunContract.isolation = "vercel-sandbox"` for requested command sessions
- `Receipt.runner.isolation`
- workspace manifests and artifact hashes
- `secret.released`
- `network.connected`
- `boundary.crossed`
- `ReceiptBundle` offline verification
- `@warrant/adapter-compute` caller shape and per-command receipt records

Metadata-only additions:

- `HarnessRunRequestV1.metadata.hardening`
- `HarnessRunResultV1.metadata.hardening`
- `HarnessCandidateRecordV1.metadata.hardening`
- runtime provider, runtime image, snapshot id, network policy, cleanup status,
  and secret absence scan scope

Receipt compatibility is covered by focused tests:

- `packages/protocol/src/test/protocol.test.ts` asserts a
  `vercel-sandbox` receipt bundle verifies with `verifyReceiptBundle()` and
  renders through the receipt story with `story.isolation = "vercel-sandbox"`.
- `packages/protocol/src/test/model-fusion.test.ts` asserts nested
  `metadata.hardening` microVM evidence remains accepted by Model Fusion
  records, while speculative top-level `microvm` fields are still rejected.

Future schema candidates:

- first-class candidate isolation kind `"microvm"`
- attestation document hash
- VM image digest
- sandbox id
- snapshot id
- cleanup/attestation event types

Do not add these schema fields until a design partner or auditor requires them.
The current governed-run receipt already names `vercel-sandbox` as the isolation
tier and remains offline-verifiable.

## Migration plan

1. Keep ENG-595 container hardening as the default candidate hardening bridge.
2. Add measurement and docs from this spike.
3. Configure an opt-in runner pool with `vercel-sandbox` for compute and command
   sessions.
4. Teach candidate isolation metadata to record `vercel-sandbox` when a candidate
   path uses that pool or session backend.
5. Promote Vercel Sandbox to the recommended hardening tier after live warm-cache
   measurements show `<30s` overhead.
6. Defer raw Firecracker until self-hosted isolation, customer VPC execution, or
   attestation evidence is a hard requirement.

## Risks

- Live measurements require credentials and may not run in CI.
- Vercel Sandbox platform behavior can change; keep docs and measurements fresh.
- Snapshot acceleration is only real after we maintain the snapshot lifecycle.
- Metadata-only hardening may be insufficient for some auditors; that should
  drive explicit schema changes, not speculative fields.
