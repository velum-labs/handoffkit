# Preflight — hypergrid hill-climb run 20260712-0843

Gate per `analysis/hypergrid/PLAN.md`. All required items PASS; experiments may
begin.

| Capability | Verdict | Evidence |
|---|---|---|
| Hyperkit CLI + engine | PASS | `plan/apply/collect` round-trip on `smoke.py`: 3 cells / 9 shards / 9 results; 45 hyperkit tests green; ruff + pyright clean |
| FusionKit SUT (`fusionkit-serve`) | PASS | boots from inline `serve_config` (flat FusionConfig schema fix), `/v1/models` lists panel + passthrough ids; fused smoke cell answered 2/2 |
| LCB adapter kernels | PASS | smoke exercised `first` (solo), serve judge+synth, and `public-exec` (n=2); grading + selection + cost metering all live |
| Provider keys (billed smokes) | PASS | OpenRouter: ds32 OK ($1.6e-6), gpt-5.5 OK, opus-4.8 OK (all with `usage.cost` returned). Native OPENAI_API_KEY rejects `max_tokens<16` but anchors run via OpenRouter anyway |
| Benchmark data | PASS | 220-instance problem store built at `~/.cache/hyperkit/livecodebench` (1.7 GB) from HF jsonl; public/private decode verified in tests |
| AWS reachability | PASS | sts assumes `cursor-agent-infra`; **hyperkit Batch stack NOT deployed** (no queues) -> local backend (decision recorded) |
| Docker + Grafana stack | PASS | local compose healthy; dashboard validator green (115 queries / 10 dashboards); **cloud stack live at http://100.54.204.108/** (EC2 `i-0a60394050bfe47b7`, Prometheus basic-auth verified 401/200) |
| Telemetry / OTLP | PASS | local-controller pushed smoke CellSnapshots to cloud Prometheus; `hyperkit_cell_resolution_rate` returns 3 cells |

## Known issues carried into the run

1. One smoke fused shard (`abc390_g`, hard) exceeded the 900 s request timeout:
   multi-stage judge+synth on hard problems is slow. Mitigation shipped:
   `request_timeout_s` / `attempts` are now kernel params; fused cells will run
   with `attempts=1-2` and a larger timeout so a timeout is recorded, not re-billed.
2. Anchors run via OpenRouter (single key path); prices equal provider list
   prices ($5/$30 gpt-5.5, $5/$25 opus-4.8).
3. Contamination caveat (documented in STARTING_POINT.md): the LCB window
   predates all evaluated models; paired comparisons remain fair.

## Spend so far

Smoke: **$0.0093** metered via `ShardResult.cost_usd` (OpenRouter exact costs).
Key smokes: < $0.01. Ledger continues in this directory.

## Generation-0 execution plan

- Open solo screen: 11 cells x 110 dev instances, `--only "solo-*"`.
- Anchors at the 60-instance rung first (`--only "anchor-*" --rung 60`),
  promoted to 110 only if needed (shard-reuse protocol).
- 12 local workers; live dashboards at http://100.54.204.108/.
