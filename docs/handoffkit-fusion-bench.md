# HandoffKit Fusion Bench Integration

FusionKit can now ingest HandoffKit coding-harness results through the model-fusion contract record stream.

This path is for coding tasks where FusionKit owns the benchmark/run aggregation and HandoffKit owns governed agent execution.

## What landed

- `harness-run-request.v1` is registered in the FusionKit contract bindings.
- `fusionkit_evals.fusion_bench` can invoke a HandoffKit command executor for `harness_coding` tasks.
- The real HandoffKit e2e test covers stdin task handoff, stdout record parsing, candidate ingestion, synthesis verification, and unavailable-harness taxonomy.
- The executor supports deterministic environment overrides and removals so credential-gated harness behavior can be tested without leaking local credentials.

## Record contract

HandoffKit emits a stdout JSON envelope:

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

FusionKit parses the envelope and joins the records into benchmark attempt rows. HandoffKit exits `0` for structured harness-level `failed` or `skipped` results so FusionKit can classify evidence instead of losing stdout on subprocess failure.

## Verification

Run the normal FusionKit gate:

```bash
uv run ruff check .
uv run pyright
uv run pytest
```

Known local verification from the implementation pass:

- FusionKit: `All checks passed!`, `0 errors, 0 warnings`, `101 passed`
- HandoffKit: `# tests 278`, `# pass 275`, `# skipped 3`

## Live Codex smoke evidence

A live HandoffKit Codex responses smoke succeeded during integration work:

- Artifact dir: `/Users/alen/.openclaw/workspace/artifacts/handoffkit-codex-live-responses-20260617T032450Z`
- `harness-run-result`: `succeeded`
- candidate: `succeeded`
- provider kind: `responses`
- evidence included `exit_code=0`
- transcript contained `HANDOFF_CODEX_OK`

This is proof of the HandoffKit live harness path. It is not the same as the local MLX panel demo.

## Boundaries

- FusionKit does not execute vendor CLIs directly in the server process.
- HandoffKit owns governed CLI execution, transcripts, tool journals, and worktree evidence.
- FusionKit owns run aggregation, record validation, benchmark row generation, and report semantics.
- Credential-gated live harnesses should remain opt-in and test-skipped when credentials are absent.
