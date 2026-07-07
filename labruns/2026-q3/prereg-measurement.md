# Phase C measurement preregistration (lite) — 2026-q3 cycle

**Committed:** 2026-07-07 (updated for FusionKit panel-only architecture).
**Spend cap:** $75 total across all Phase C runs in this cycle.
**Domain:** algorithmic coding only (LiveCodeBench-style, stdin/stdout grading).

## Architecture constraint

All panel hypotheses use FusionKit's **shipped** ensemble path only:

```
parallel panel → judge → synthesizer → one answer
```

- Judge and synthesizer are **panel members** (strongest member: `ds32` or
  `ds32_64k`).
- No cascade, Self-MoA, or `exec_select` topologies in this cycle.
- H3 (cascade) is out of scope until the product supports it.
- H4 is a **comparison metric** (`best-single` from `fusion_bench`), not a
  separate config.

## Panel configs to run

| Hypothesis | Config | Status |
|---|---|---|
| H1 backbone | `configs/benchmark-panel.h1-backbone.yaml` | ready |
| H2 style-diverse | `configs/benchmark-panel.h2-style-diverse.yaml` | ready |
| H5 thinking-heavy | `configs/benchmark-panel.h5-thinking-heavy.yaml` | ready |
| H3 cascade | — | out of scope |
| H4 best-single | — | metric from each run's compound report |

## Task manifest

- Suite: `livecodebench` via `livecodebench_adapter.py`
- Subset: ~60 tasks (directional signal; not launch-grade)
- Manifest committed before any API call: `labruns/2026-q3/manifest-algorithmic.jsonl`
  (to be fixed at Phase C start)

## Metrics (mandatory per panel run)

1. Fused pass rate (`synthesized_success`)
2. Best-single pass rate (strongest panel member alone)
3. Per-member pass rates
4. Judge-synthesis regret (oracle − fused, diagnostic)
5. Truncation rate per model; refuse any model with >10% truncated rows
6. $/task from spend ledger

## Verdict rules (from hypothesis cards)

| Hypothesis | Kill / promote rule |
|---|---|
| H1 | Kill if best-single ≥ fused; promote if fused beats best-single by ≥2 pp |
| H2 | Kill if H2 ≤ H1 on same tasks |
| H5 | Kill if H5 ≤ H1 on full bank |
| H4 (metric) | If best-single ≥ all panels → `routing_wins` verdict |

Promote at most **1–2** surviving panels to Phase D.

## Smoke command (Phase B)

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.h1-backbone.yaml \
  uv run fusionkit public-bench --suite livecodebench --subset 5 \
  --runner-command "uv run python python/fusionkit-evals/src/fusionkit_evals/adapters/livecodebench_adapter.py" \
  -o .fusionkit/fusion-bench/smoke-h1.jsonl
```

Repeat for H2 and H5 configs.

## Still not publishable

Phase C numbers are internal and directional only. Evidence cards require Phase D.
