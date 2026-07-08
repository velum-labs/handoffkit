# Phase C status — 2026-q3 cycle

**Updated:** 2026-07-08 (judge experiment COMPLETE)  
**Spend cap:** $75 (preregistered) — **$35.52 used**  
**Manifest:** `labruns/2026-q3/manifest-algorithmic.jsonl` (60 tasks: 42 hard, 18 medium)

## Judge experiment — done

All six panels completed 2026-07-08 (run id `20260708T171321Z`), after the
retry/timeout fixes (`max_retries=0` in SDK clients + `LCB_TASK_TIMEOUT_S`
wall clock). Full analysis: `labruns/2026-q3/results-judge-experiment.md`.

| ID | Panel | Judge | Fused | Cost |
|----|-------|-------|-------|------|
| j1-g | dsv4pro, mimo, gemini | gemini | 24/59 | $5.35 |
| j1-m | dsv4pro, mimo, gemini | mimo | 24/58 | $5.00 |
| j2-g | minimax, mimo, gemini | gemini | 23/60 | $5.70 |
| j2-m | minimax, mimo, gemini | mimo | 25/60 | $5.75 |
| j3-g | kimi, mimo, gemini | gemini | 25/60 | $6.59 |
| j3-m | kimi, mimo, gemini | mimo | 23/60 | $6.54 |

Key takeaways: judge identity (gemini vs mimo) is a wash; judge regret is zero
in all runs (fused ≥ candidate oracle, synthesis uplift up to +3); the cheap
pool is capability-capped — 32/60 tasks never solved by anything across all
runs. See results doc for per-member rates and next-step levers.

## Legacy H1

Complete: **23/60** fused pass (38.3%).

## Artifacts

- Reports + per-task JSONL: `labruns/2026-q3/results/judge-exp/`
- Live run dir (untracked): `labdata/runs/2026-q3/phase-c/`
- Spend ledger snapshot: `labruns/2026-q3/results/judge-exp/spend_ledger-20260708.jsonl`

## Commands (reference)

```bash
# Full judge matrix, parallel, with hang fixes
LCB_CONCURRENCY=2 LCB_TASK_TIMEOUT_S=2400 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix --parallel
```
