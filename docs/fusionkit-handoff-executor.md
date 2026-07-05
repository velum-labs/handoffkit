# FusionKit Handoff Executor

`warrant ensemble handoff` is the HandoffKit side of the FusionKit coding-harness seam.

It lets FusionKit send a `benchmark-task-record.v1` payload on stdin, run one or more governed harness candidates, and receive a pure JSON record envelope on stdout.

## Command

```bash
printf '%s' "$BENCHMARK_TASK_JSON" | \
  warrant ensemble handoff \
    --harness codex \
    --repo /path/to/repo \
    --out /tmp/handoff-artifacts \
    --id codex_live \
    --model codex=gpt-5.1-codex-mini \
    --timeout-ms 180000
```

Use `node packages/cli/dist/index.js ensemble handoff` before the CLI package is linked globally.

## Output contract

Stdout is intentionally machine-only JSON:

```json
{
  "records": [
    { "schema": "benchmark-task-record.v1" },
    { "schema": "harness-run-request.v1" },
    { "schema": "harness-run-result.v1" },
    { "schema": "harness-candidate-record.v1" },
    { "schema": "judge-synthesis-record.v1" }
  ]
}
```

Human diagnostics and warnings go to stderr. This lets FusionKit parse stdout without filtering narrative text.

## Failure semantics

The command exits `0` for structured harness-level `failed` or `skipped` records. That is deliberate: FusionKit needs the record envelope to classify evidence, unavailable providers, credential gaps, and candidate failures.

The command exits nonzero for CLI misuse, invalid arguments, invalid stdin, or errors that prevent a record envelope from being produced.

`ensemble handoff` rejects positional prompts. The task must come from stdin so FusionKit can preserve the exact benchmark task record and hash.

## Artifacts

The `--out` directory receives run records, candidate records, judge synthesis records, harness transcripts, tool journals, worktree evidence, and verification metadata. Artifact paths are referenced from the emitted records.

Live Codex responses smoke evidence from the implementation pass:

- Artifact dir: `~/fusionkit-artifacts/handoffkit-codex-live-responses-20260617T032450Z`
- `harness-run-result`: `succeeded`
- candidate: `succeeded`
- provider kind: `responses`
- verification evidence included `exit_code=0`
- transcript contained `HANDOFF_CODEX_OK`

## Verification

Run the repo gate:

```bash
/opt/homebrew/bin/corepack pnpm check
/opt/homebrew/bin/corepack pnpm build
/opt/homebrew/bin/corepack pnpm test
```

Known local verification from the implementation pass:

```text
# tests 278
# pass 275
# skipped 3
```

Warnings about `${PACKAGES_READ_TOKEN}` in `.npmrc` are expected in local environments that do not have the private package read token exported. They do not invalidate the local check/build/test gate when the command exits `0`.

## Boundaries

- HandoffKit owns governed harness execution, transcript capture, artifacts, and verification metadata.
- FusionKit owns benchmark aggregation, record joins, report semantics, and product run inspection.
- Credential-gated live harnesses should remain opt-in and should produce structured `skipped` records when credentials are unavailable.
- Do not write secrets, API keys, or raw customer data into records, fixtures, transcripts, or docs.
