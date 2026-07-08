# Phase C status — 2026-q3 cycle

**Updated:** 2026-07-08  
**Spend cap:** $75 (preregistered)  
**Manifest:** `labruns/2026-q3/manifest-algorithmic.json` (60 tasks)

## Judge experiment

| ID | Panel | Judge | Status |
|----|-------|-------|--------|
| j1-g | dsv4pro, mimo, gemini | gemini | **paused** (1/60 in ~4h; hard tasks ~3.5h each; hung `arc196_c`) |
| j1-m | dsv4pro, mimo, gemini | mimo | **running** (parallel) |
| j2-g | minimax, mimo, gemini | gemini | pending (after MiMo trio) |
| j2-m | minimax, mimo, gemini | mimo | **running** (parallel) |
| j3-g | kimi, mimo, gemini | gemini | pending |
| j3-m | kimi, mimo, gemini | mimo | **running** (parallel) |

### Changes (2026-07-08)

- Killed stuck **j1-g** sequential run.
- Added **`timeout_s: 600`** on all judge-exp endpoints (was 120s default; hung for hours).
- Restarted **MiMo-judge trio in parallel**: `run-judge-matrix --mimo-only --parallel`
- tmux session: `phase-c-judge-mimo`
- Log: `labdata/runs/2026-q3/phase-c/judge-mimo-parallel.log`

### j1-g partial (before pause)

5/60 cached; 1 pass (`abc400_e`). Hard `arc196_*` tasks: ~3.5h each, empty panel code, prose/LaTeX fused output.

### Legacy H1

Complete: **23/60** fused pass (38.3%); ledger ~$0.53.

## Commands

```bash
# MiMo trio (current)
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix --mimo-only --parallel

# Gemini trio later (with timeouts)
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix --gemini-only --parallel
```

Spend ledger: `labdata/runs/2026-q3/phase-c/spend_ledger.jsonl`
