# Preflight — hypergrid hill-climb restart 20260713-0850

Gate per `analysis/hypergrid/PLAN.md`. All required capabilities pass; billed
experiments remain blocked until their lab proposal PR is merged.

| Capability | Verdict | Evidence |
|---|---|---|
| Environment | PASS | `uv sync --all-packages --extra aws`; Node 22.22.2; `pnpm install --frozen-lockfile`; `pnpm build` |
| Hyperkit CLI + engine | PASS | Ephemeral `preflight-stub` benchmark/SUT entry points completed `plan/apply/status/collect`: 1 cell, 1 zero-cost shard, 1/1 resolved; `livecodebench`, `solo-model`, `fusionkit-serve`, local, and `aws-batch` plugins resolve |
| FusionKit SUT | PASS | `fusionkit-serve` booted from inline `serve_config`; `/v1/models` returned HTTP 200 and included `fusionkit/panel` |
| Provider keys | PASS | OpenRouter ds32 returned one output token and `$0.0000022` metered cost; native OpenAI resolved `gpt-5.5-2026-04-23`; native Anthropic resolved `claude-opus-4-8` |
| Model availability | PASS | OpenRouter catalog contains all 11 open-screen models plus `openai/gpt-5.5` and `anthropic/claude-opus-4.8` (13/13) |
| Benchmark data | PASS | All six HF `livecodebench/code_generation_lite` JSONL shards are reachable; a row decoded to stdin public/private tests; committed eligible pool is 220 tasks (68 medium, 152 hard), split 110 dev / 70 holdout / 40 spare |
| AWS substrate | PASS | STS account `052777341990`; S3 bucket reachable with all 220 `lcb-store/` objects; Batch queue `hypergrid-batch-queue` is ENABLED/VALID; job definition `hypergrid-batch-runner:1` is ACTIVE; SQS API reachable (no queue required by polling controller) |
| Grafana / Prometheus | PASS | Joined the tailnet in userspace mode; Grafana `/api/health` returned 200 through `socks5h://localhost:1055`; authenticated Prometheus `/-/healthy` returned 200 |
| Telemetry / OTLP | PASS | `hyperkit.telemetry.configure()` exported a uniquely labelled test metric through the scoped tailnet HTTP proxy; Prometheus query returned one series with value 1 |

## Execution decision

- Use `--backend aws-batch` with bucket
  `hypergrid-batch-052777341990-us-east-1`, queue
  `hypergrid-batch-queue`, and job definition `hypergrid-batch-runner:1`.
- Cloud runners fetch individual problems from the complete S3 store, so no
  local 1.7 GB LCB store was built.
- Run the S3-polling controller locally with no SQS, OTLP basic auth from SSM,
  and proxy variables scoped to that process.

## Spend

This restart's three provider checks cost less than $0.001; no experiment
shards were submitted. Campaign spend remains approximately **$5.11 of $250**,
with the **$60 locked-final reserve untouched**.
