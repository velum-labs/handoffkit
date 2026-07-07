# Phase B smoke results — 2026-q3 cycle

**Date:** 2026-07-07  
**Runner:** `labruns/2026-q3/scripts/smoke_panels.py`  
**Artifact:** `.fusionkit/fusion-bench/phase-b-smoke.json`

## Method

Per config, the smoke script:

1. Loads the benchmark-panel YAML via `fusionkit_core.config.load_config`
2. Calls each OpenRouter endpoint with a trivial chat (`Reply with exactly: OK`)
3. Runs one fused `panel` turn (all members + in-panel judge/synthesizer)

This satisfies Phase B pass criteria (model IDs resolve, fusion path completes)
without loading the full LiveCodeBench Hugging Face dataset.

### Note on `public-bench` / LiveCodeBench adapter

An initial attempt using:

```bash
uv run --with 'datasets<4' fusionkit public-bench --suite livecodebench --subset 5 \
  --runner-command "uv run --with 'datasets<4' python .../livecodebench_adapter.py"
```

failed with **exit 137 (OOM)** while the adapter downloaded/generated the full
`livecodebench/code_generation_lite` test split (~1000 rows) before subset
selection. That path remains valid for Phase C when run with a frozen
`LCB_MANIFEST` or on a machine with more memory; it is not required for Phase B
identity smoke.

## Results

| Hypothesis | Config | Endpoints | Panel fusion | Verdict |
|---|---|---|---|---|
| H1 backbone | `configs/benchmark-panel.h1-backbone.yaml` | ds32, nemotron3s, dsv4pro — all OK | 3 trajectories, fused output OK | **PASS** |
| H2 style-diverse | `configs/benchmark-panel.h2-style-diverse.yaml` | ds32, nemotron3s, glm52 — all OK | 3 trajectories, fused output OK | **PASS** |
| H5 thinking-heavy | `configs/benchmark-panel.h5-thinking-heavy.yaml` | ds32_64k, kimi26_64k, nemotron3s_64k — all OK | 3 trajectories, fused output OK | **PASS** |

**Exit code:** 0  
**Wall time:** ~586s (~9.8 min) for all three configs sequentially.

## Phase B status

- [x] Mechanical YAML validation (lineage veto, in-panel judge)
- [x] Smoke passed for H1, H2, H5
- [x] `prereg-measurement.md` committed
- [x] Hypothesis cards updated to `smoke_passed`
- [x] No publishable claims

**Phase B complete.** Ready for Phase C subject to `manifest-algorithmic.jsonl` fix.
