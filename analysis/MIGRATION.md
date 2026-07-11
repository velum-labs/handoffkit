# Benchmark infrastructure migration to Hyperkit

Clean break: no backwards-compatible runner/analyzer shims.

| Former surface | Hyperkit replacement |
|---|---|
| `analysis/k1-swebench/**/run*.sh` | `analysis/hyperkit/k1_driver_confirm.py` + `hyperkit plan/apply/resume/collect` |
| `analysis/k1-round1/scripts/*.sh` | `analysis/hyperkit/k1_terminal_round1.py` |
| `analysis/k1-*/scripts/analyze*.py` | normalized `ShardResult` + `hyperkit collect`; committed SWE reports replay through `hyperkit replay-swebench` |
| `logging_proxy.py` / `otlp_collector.py` | first-class OTLP: runner + FusionKit spans -> ADOT -> Prometheus/X-Ray -> Grafana |
| duplicate Wilson / clustered bootstrap functions | `hyperkit.stats` only |
| `python/fusionkit-lab` / `fklab` registry | `python/hyperkit/registry` + `hyperkit.core.registry` |
| copied serve/health/teardown blocks | `hyperkit.core.RunOrchestrator` |
| local worker caps / earlyoom | adapter `ResourceProfile` -> AWS Batch memory reservation |

The historical reports, preregistrations, configs, manifests, trajectories,
official harness reports, and `preds.json` artifacts remain committed. Only the
bespoke execution/analyzer code was deleted after Hyperkit's replay acceptance
reproduced the seed-45 table:

- `solo-terminus`: 19/30
- `driver-v2`: 16/30

Phase0 / thinking-32k / seed-audit analysis code remains as FusionKit-specific
consumer code, but its shared statistics now import `hyperkit.stats`. Their
next live runs should be expressed as Hyperkit Experiments and the remaining
FusionKit-specific logic moved into adapter/SUT plugins rather than copied.

