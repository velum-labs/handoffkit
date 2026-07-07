# Judge experiment preregistration — 2026-q3 cycle

**Committed:** 2026-07-07  
**Spend cap:** $75 total (shared with any other Phase C runs in `spend_ledger.jsonl`)  
**Manifest:** `labruns/2026-q3/manifest-algorithmic.json` (60 tasks, frozen before API calls)

## Question

For fixed 3-member panels where **MiMo** and **Gemini 3.1 Pro** are always present and the
third member rotates, does swapping only the **judge/synthesizer** (Gemini vs MiMo) change fused
LiveCodeBench pass rate enough to matter?

## Design

- **3 panel members** each run; judge and synthesizer are one of those members (in-panel constraint).
- **MiMo** (`xiaomi/mimo-v2.5-pro`) and **Gemini** (`google/gemini-3.1-pro-preview` on OpenRouter)
  are fixed on every panel.
- Third member rotates across three anchors: **dsv4pro**, **minimax-m3**, **kimi-k2.7-code**.
- Within each anchor pair, panel membership is identical; only `judge_model` / `synthesizer_model`
  swap between Gemini and MiMo.

| ID | Third member | Judge |
|----|--------------|-------|
| j1-g | deepseek-v4-pro | gemini |
| j1-m | deepseek-v4-pro | mimo |
| j2-g | minimax-m3 | gemini |
| j2-m | minimax-m3 | mimo |
| j3-g | kimi-k2.7-code | gemini |
| j3-m | kimi-k2.7-code | mimo |

Configs: `configs/benchmark-panel.judge-exp.j{1,2,3}-{gemini,mimo}.yaml`

## Metrics (same as Phase C prereg)

1. Fused pass rate (`synthesized_success`)
2. Best-single pass rate (strongest panel member alone)
3. Per-member pass rates
4. Judge-synthesis regret (oracle − fused)
5. Truncation rate per model
6. $/task from spend ledger

## Comparisons (predeclared)

- **Within anchor:** j1-g vs j1-m, j2-g vs j2-m, j3-g vs j3-m (judge effect holding panel fixed).
- **Across anchors:** best fused among j*-g vs best among j*-m.
- **Fusion uplift:** fused vs best-single per config.

## Execution

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py preflight --hypothesis j1-g
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix
# optional parallel:
LCB_CONCURRENCY=2 uv run --with 'datasets<4' \
  python labruns/2026-q3/scripts/run_phase_c.py run-judge-matrix --parallel
```

Smoke (Phase B style):

```bash
uv run python labruns/2026-q3/scripts/smoke_panels.py \
  configs/benchmark-panel.judge-exp.j1-gemini.yaml \
  configs/benchmark-panel.judge-exp.j1-mimo.yaml
```

## Notes

- Gemini routes via **OpenRouter** only (`OPENROUTER_API_KEY`); slug is
  `google/gemini-3.1-pro-preview` (no bare `google/gemini-3.1-pro` id on OpenRouter as of 2026-07-07).
- Legacy H1/H2/H5 runs are superseded by this matrix for Phase C prioritization.
