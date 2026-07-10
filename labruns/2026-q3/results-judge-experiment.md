# Judge experiment results — Phase C, 2026-q3

**Completed:** 2026-07-08 (all six panels, run id `20260708T171321Z`)
**Manifest:** `labruns/2026-q3/manifest-algorithmic.jsonl` — 60 LiveCodeBench tasks,
42 hard / 18 medium, contest window 2025-02-08 → 2025-04-06.
**Spend:** $34.93 for the six runs (ledger total $35.52 incl. H1/preflights; cap $75).

## Headline

| Run | Panel (3rd member) | Judge/Synth | Fused | Candidate oracle | Synthesis uplift | Cost |
|-----|--------------------|-------------|-------|------------------|------------------|------|
| j1-g | dsv4pro | gemini | **24/59** (40.7%) | 21/59 | +3 / −0 | $5.35 |
| j1-m | dsv4pro | mimo | **24/58** (41.4%) | 23/58 | +1 / −0 | $5.00 |
| j2-g | minimax | gemini | **23/60** (38.3%) | 23/60 | +0 / −0 | $5.70 |
| j2-m | minimax | mimo | **25/60** (41.7%) | 23/60 | +2 / −0 | $5.75 |
| j3-g | kimi | gemini | **25/60** (41.7%) | 23/60 | +2 / −0 | $6.59 |
| j3-m | kimi | mimo | **23/60** (38.3%) | 23/60 | +0 / −0 | $6.54 |

All panels share `xiaomi/mimo-v2.5-pro` + `google/gemini-3.1-pro-preview`; the
third member rotates. "Candidate oracle" = tasks where ≥1 panel member's own
candidate passed. "Synthesis uplift" = fused passes on tasks where **no**
candidate passed / fused misses on tasks where a candidate passed.

## Findings

### 1. Judge identity is a wash

Head-to-head on identical task sets: gemini-judge won j1 (+1) and j3 (+2),
mimo-judge won j2 (+2). Aggregate 72 vs 71 over 3 matched pairs — well inside
noise. **The judge choice (gemini vs mimo) does not move the score.** MiMo-judge
panels are materially cheaper and faster, so MiMo is the default judge going
forward unless later evidence splits them.

### 2. Judge regret is zero — and synthesis uplift is real

In **every** run, fused ≥ candidate oracle. The pipeline never lost a task that
a member had solved, and in 4/6 runs the synthesizer produced passing code on
tasks where *no* candidate passed (up to +3). The judge/synthesis stage is not
the bottleneck; **member capability is.**

### 3. The panel pool is capability-capped at ~28/60

Across all six runs — 5 distinct member models, 18 member-run samples —
only **24/60** distinct tasks were ever solved by any candidate, and **28/60**
by any fused answer. The remaining **32 tasks (28 hard, 4 medium) were never
solved by anything**. Failure correlations run 0.54–0.89. More cheap-model
diversity at this tier buys at most a couple of tasks.

### Per-member pass counts (this manifest)

| Model | Pass (range across runs) | Rate |
|-------|--------------------------|------|
| google/gemini-3.1-pro-preview | 19–22 / 60 | 32–37% |
| deepseek/deepseek-v4-pro | 19–22 / 60 | 32–37% |
| moonshotai/kimi-k2.7-code | 21 / 60 | 35% |
| deepseek ds32 (H1) | 18 / 60 | 30% |
| xiaomi/mimo-v2.5-pro | 16–18 / 60 | 27–30% |
| nemotron3s (H1) | 14 / 60 | 23% |
| minimax/minimax-m3 | 10–12 / 60 | 17–20% |

Note the run-to-run variance (gemini 19→22 on the same tasks): per-model
sampling noise is ±3 tasks, so single-run comparisons under ~5 pp are not
meaningful, and multi-sampling is a real lever.

### 4. No frontier baseline exists on this manifest yet

Published LCB leaderboard numbers (deepseek-v4-pro 93.5%, gpt-5.3-codex 71.2%,
claude-opus-4.6 68.1%) are on the full release_v6 mix including easy tasks —
dsv4pro scores 93.5% there but only ~35% on our hard-skewed subset, so those
numbers do not transfer. A solo frontier run on this manifest is the only
honest reference.

## Verdict / next steps

- **Keep MiMo as judge** (tied with gemini, cheaper).
- **Stop adding sub-$1/M models** — pool is capability-capped at ~28/60.
- Levers, in order of expected value per dollar:
  1. Solo frontier baseline (e.g. `gpt-5.5`, ~$8–15) to fix the target.
  2. Multi-sample existing strong members (`sample_count 2–3`) to harvest
     the ±3-task variance into the oracle.
  3. Swap the weakest slot (minimax/mimo) for an untried mid-tier coder
     rather than adding panel width.

Raw artifacts: `labruns/2026-q3/results/judge-exp/` (reports + per-task JSONL).
