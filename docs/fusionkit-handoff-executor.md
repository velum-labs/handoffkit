# FusionKit Handoff Executor

`fusionkit ensemble handoff` is an advanced maintainer executor for FusionKit benchmark and harness-development workflows.

It lets FusionKit send a `benchmark-task-record.v1` payload on stdin, run one or more governed harness candidates, and receive a pure JSON record envelope on stdout.

## Command

```bash
printf '%s' "$BENCHMARK_TASK_JSON" | \
  fusionkit ensemble handoff \
    --harness codex \
    --repo /path/to/repo \
    --out /tmp/handoff-artifacts \
    --id codex_live \
    --model codex=gpt-5.1-codex-mini \
    --timeout-ms 180000
```

Use `node packages/cli/dist/index.js ensemble handoff` before the CLI package is linked globally.

`--harness` defaults to `mock`; valid values are `mock | command | claude-code | codex`
(`packages/cli/src/commands/ensemble.ts`). Use `--harness command` together with
`--command <cmd>` to run a custom executor script. The Python bench side plugs
this executor in via `fusionkit fusion-bench --handoff-command "fusionkit ensemble handoff ..."`.

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
corepack pnpm check
corepack pnpm build
corepack pnpm test
```

Exact test counts drift as suites grow; the gate is that check, build, and test
all pass.

## Boundaries

- FusionKit owns the stdin/stdout executor contract, transcript capture, artifacts, and verification metadata for this maintainer workflow.
- FusionKit owns benchmark aggregation, record joins, report semantics, and product run inspection.
- This page is maintainer-facing; it is not a user quickstart.
- Credential-gated live harnesses should remain opt-in and should produce structured `skipped` records when credentials are unavailable.
- Do not write secrets, API keys, or raw customer data into records, fixtures, transcripts, or docs.
