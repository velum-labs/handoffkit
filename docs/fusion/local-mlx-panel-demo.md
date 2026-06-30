# Local MLX Panel Demo

This demo proves FusionKit can run a native `/v1/fusion/runs` panel against three real Apple Silicon MLX models through OpenAI-compatible local endpoints.

It is a product-path demo, not a benchmark claim. It exercises the native run manager, model-call records, judge synthesis, artifacts, event replay, and inspection APIs.

## What it runs

- `mlx-community/Qwen3-1.7B-4bit` as `qwen-judge`
- `mlx-community/gemma-3-1b-it-4bit` as `gemma-writer`
- `mlx-community/Llama-3.2-1B-Instruct-4bit` as `llama-planner`
- `scripts/simple_mlx_openai_server.py` for a minimal OpenAI-compatible chat server per model
- `fusionkit serve` on a generated local config
- `POST /v1/fusion/runs`, followed by summary, inspect, and events reads

The wrapper is intentionally small because `mlx_lm.server` was flaky on this path during the first demo pass. It hit a Transformers compatibility issue and a KV-cache merge crash after a successful request. The wrapper uses direct `mlx_lm.load` and `mlx_lm.generate` calls and serializes requests per model process.

## Running

Apple Silicon is required.

```bash
./scripts/run_local_mlx_panel_demo.sh
```

Useful overrides:

```bash
FUSIONKIT_DEMO_ARTIFACT_DIR=/tmp/fusionkit-demo \
FUSIONKIT_MLX_VENV=$HOME/.cache/fusionkit/mlx-demo-venv \
FUSIONKIT_DEMO_PORT=8388 \
./scripts/run_local_mlx_panel_demo.sh
```

The script creates or reuses a Python 3.12 venv, installs `mlx-lm==0.29.1` and `transformers<5`, starts three local model servers, starts FusionKit, runs the panel request, and writes all artifacts under the artifact directory.

## Expected evidence

A successful run writes:

- `run.log`: environment, readiness, and command output
- `models.local.yaml`: generated FusionKit model config
- `request.json`: `fusion-run-request.v1`
- `run-response.json`, `run-summary.json`, `inspect.json`, `events.json`
- `summary.json`: condensed evidence fields
- `DEMO.md`: human-readable proof artifact
- `fusionkit-artifacts/`: copied candidate and final output artifacts
- `simple-*.log`: per-model server logs with token counts and latency

The summary should show:

```json
{
  "state": "completed",
  "status": "succeeded",
  "candidate_count": 3,
  "model_call_count": 3,
  "event_count": 13,
  "artifact_count": 4,
  "judge_parse_status": "parsed"
}
```

## Known good runs

- `run_0d046b81bc0940289cf282b6a12e70d9`: first stronger-model pass. It completed with 3 candidates, 13 events, and 4 artifacts, but the judge structured parse failed.
- `run_cdfc7ce9e88b4955af6369faebeafe49`: polished pass. It completed with 3 candidates, 13 events, 4 artifacts, and judge structured parse `parsed`.
- `run_bc7d0a3a6af54367b68df58fadbe1e49`: fresh verification pass. It completed with 3 candidates, 13 events, 4 artifacts, and judge structured parse `parsed`.

The local artifact directories for those runs were under `/Users/alen/.openclaw/workspace/artifacts/` on `velum-mini`. They are evidence from that machine, not portable repository fixtures.

## Rules

- Do not treat this as a public benchmark result.
- Do not commit generated `.fusionkit/` run stores or local artifact directories.
- Keep local model endpoints secret-free. The demo uses `api_key: not-needed`.
- If `mlx_lm.server` becomes stable enough, keep this wrapper as a deterministic smoke harness rather than deleting it.
