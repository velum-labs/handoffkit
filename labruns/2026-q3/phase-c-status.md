# Phase C status — 2026-q3 cycle

**Updated:** 2026-07-07  
**Spend cap:** $75 (preregistered)  
**Manifest:** `labruns/2026-q3/manifest-algorithmic.json` (60 tasks, committed before API calls)

## Current focus: judge experiment

User-approved 3×2 matrix (see `prereg-judge-experiment.md`):

| ID | Panel | Judge | Config |
|----|-------|-------|--------|
| j1-g | dsv4pro, mimo, gemini | gemini | `benchmark-panel.judge-exp.j1-gemini.yaml` |
| j1-m | dsv4pro, mimo, gemini | mimo | `benchmark-panel.judge-exp.j1-mimo.yaml` |
| j2-g | minimax, mimo, gemini | gemini | `benchmark-panel.judge-exp.j2-gemini.yaml` |
| j2-m | minimax, mimo, gemini | mimo | `benchmark-panel.judge-exp.j2-mimo.yaml` |
| j3-g | kimi, mimo, gemini | gemini | `benchmark-panel.judge-exp.j3-gemini.yaml` |
| j3-m | kimi, mimo, gemini | mimo | `benchmark-panel.judge-exp.j3-mimo.yaml` |

Gemini OpenRouter slug: `google/gemini-3.1-pro-preview`.

## Infrastructure

| Item | Status |
|------|--------|
| LCB streaming loader (OOM fix) | Done |
| Frozen manifest | Committed |
| Runner script + judge matrix | `run_phase_c.py` (`run-judge-matrix`) |
| Six judge-exp YAML configs | Committed |

## Legacy H1 run (optional / deprioritized)

Partial H1 backbone run may exist in cache (`h1-20260707T174909Z.jsonl`). The judge matrix
uses different configs and separate cache signatures.

## Commands

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
uv run python labruns/2026-q3/scripts/smoke_panels.py \
  configs/benchmark-panel.judge-exp.j1-gemini.yaml
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py preflight --hypothesis j1-g
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix
```

Spend ledger: `labdata/runs/2026-q3/phase-c/spend_ledger.jsonl`
