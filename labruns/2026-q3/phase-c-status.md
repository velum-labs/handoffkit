# Phase C status — 2026-q3 cycle

**Started:** 2026-07-07  
**Spend cap:** $75 (preregistered)  
**Manifest:** `labruns/2026-q3/manifest-algorithmic.json` (60 tasks, committed before API calls)

## Infrastructure

| Item | Status |
|------|--------|
| LCB streaming loader (OOM fix) | Done (`livecodebench_data.py`) |
| Frozen manifest | Committed (`manifest-algorithmic.json` + `.jsonl`) |
| Runner script | `labruns/2026-q3/scripts/run_phase_c.py` |
| Adapter manifest/subset fix | Done (`livecodebench_adapter.py`) |
| Adapter timeout | 2h preflight / 6h per panel run |

## Preflight (H1, 5 tasks)

- **Availability:** ran  
- **Resolved:** 5/5  
- **Fused pass rate:** 0/5 (hard LCB problems; pipeline validated)  
- **Cost:** ~$0.055  
- **Artifact:** `labdata/runs/2026-q3/phase-c/preflight-h1-20260707T174019Z.jsonl`

## Panel runs

| Hypothesis | Status | Output |
|------------|--------|--------|
| H1 backbone | **in progress** | `labdata/runs/2026-q3/phase-c/h1-20260707T174909Z.jsonl` |
| H2 style-diverse | pending | — |
| H5 thinking-heavy | pending | — |

Resume commands:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
LCB_CONCURRENCY=2 uv run --with 'datasets<4' python labruns/2026-q3/scripts/run_phase_c.py run --hypothesis h1
LCB_CONCURRENCY=2 uv run --with 'datasets<4' python labruns/2026-q3/scripts/run_phase_c.py run --hypothesis h2
LCB_CONCURRENCY=2 uv run --with 'datasets<4' python labruns/2026-q3/scripts/run_phase_c.py run --hypothesis h5
```

Runs are resumable via per-task cache in `~/.cache/fusionkit-bench/livecodebench/`.

## Spend ledger

`labdata/runs/2026-q3/phase-c/spend_ledger.jsonl`
