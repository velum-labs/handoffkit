# Fusion Production Audit — Final Report (run 20260701-2027)

Executed per `.cursor/skills/fusion-production-audit/SKILL.md` against
`docs/fusion/FUSION_VALUE_RUBRIC.md`. Providers: OpenAI + Anthropic only.
Branch: `cursor/fusion-production-audit-c70f` (base `85257b8`).

## Headline (Gate A evidence)

**Locked test — LiveCodeBench, evaluated ONCE, real FusionKit pipeline**
(release_v6, medium/hard stdin-only, ≥2025-01-01 = the full 86-task available
window; full official test sets; config frozen on the dev window first):

| model | pass@1 | 95% CI |
|---|---|---|
| gpt (gpt-5.5, primary sample) | 0.4186 | [0.320, 0.524] |
| opus (claude-opus-4-8, primary sample) | 0.4767 | [0.375, 0.581] |
| **fused compound** | **0.6628** | [0.558, 0.754] |

- **Uplift vs best single: +18.6 pts; McNemar 16 wins / 0 losses, χ²=14.06,
  p<0.001.** Artifact: `phase6/locked-test.jsonl` (+ per-stage rows in
  `phase6/locked-test-rows-with-stages.json`).
- **Shipped-path validation (Phase 6a):** 25 locked tasks through a live
  `fusionkit serve` gateway (`/v1/chat/completions`, `fusionkit/panel`):
  **0 pipeline errors**, gateway 0.80 vs engine 0.84 on the same tasks
  (1 discordant task, not significant) — `phase6/shipped-path-check.json`.
- Second family (Aider-polyglot adaptation, 103 exercises, held-out for the
  frozen incumbent): fused 0.7767 vs best single 0.7670 — positive but **not
  significant** (7W/6L); never-worse holds. The panel saturates this suite
  (best single 0.767, pool oracle 0.854) — top roadmap item.

**Final incumbent** (what the numbers describe):
`configs/benchmark-panel.gpt-opus-deep.yaml` — GPT-5.5 + Opus 4.8, **3
temperature-varied samples per member** (0.2/0.6/0.9), judge=gpt-5.5,
**judge-pick-verbatim (select-best) synthesis** with rewrite fallback. Both
changes were tuned exclusively on the frozen 2024-07→2024-12 dev window
(`phase5/dev-manifest.json`) and are shipped defaults
(`panel_samples_per_model` in config; `synthesis_select_best=True` default).

## Gate B evidence (why it wins)

- **Oracle gap (2.1):** +7.0 pts (1-sample panel) → **+14.0 pts** (deep panel,
  dev). Temperature diversity is where the headroom came from; the judge then
  converts nearly all of it: total regret on the locked run ≈ 0 (fused =
  measured oracle).
- **Regret split (3.2, instrumented this audit):** LCB judge regret ≤0
  (the pipeline outperforms the candidate pool — the rewrite fallback rescued
  5/150 dev + 2/86 locked-window tasks where EVERY candidate failed);
  polyglot judge regret 7.8 pts (judge is the weak stage there).
- **Judge selection accuracy (3.1):** 97–100% on LCB decision tasks, 79% on
  polyglot. Judge JSON parse failures: 0 in ~900+ fused calls.
- **Synthesis policy (4.1/4.2):** rewrite vs select-verbatim vs exec-select
  ablated on both families; select-best ties rewrite on pass rate with 0
  McNemar losses vs best single and 0 synthesis regressions, and skips ~71% of
  synthesizer calls → now the default. Exec-select trails at pool=6
  (0.6133 vs 0.6733 dev).
- **Self-consistency control (2.5):** multi-vendor panel beats a same-cost
  single-vendor pool (gpt×6): +6.0 pts, 11W/2L, χ²=4.92, significant —
  the second provider pays for itself.
- **Leave-one-out (2.3):** marginal oracle value gpt +8.0 pts / opus +7.3 pts.

## Economics (locked run, full pipeline metered per stage)

- Cost: $25.24 total = panel $22.55 + judge $1.33 + synth $1.36; $0.29/task,
  **$0.44 per solved task ≈ 2.8× opus-alone** (above the 2.5× bar — roadmap:
  prompt caching, hedging, adaptive depth). Shallow preset measured ≈1.8×.
- Latency p50/p95: panel 69.5/83.3s, judge 16.1/42.5s, synth 0/79.8s
  (skipped on 52/86 tasks), task total 95/182s.

## Scoring + roadmap

- `rubric-scorecard.md`: **46.2 / 104**; Gates: A rubric-strict NOT passed
  (1.1 n=86; 1.2 ns) though the skill's locked-split objective is met;
  **B PASSED**; C NOT passed (no caching/hedging, deep 2.8×); D NOT passed
  (process-enforced, not tool-enforced).
- `ROADMAP.md`: 13 items ranked by uplift-per-effort; top: n≥200 locked
  evidence + harder agentic second family, prompt caching, hedging,
  tool-enforced holdout, difficulty-adaptive depth.

## Bugs found → fixed (all with regression tests, gates green)

| commit | fix |
|---|---|
| `9beaa5e` | HF `datasets` split generation OOM-killed 16GB hosts (~100MB private-test blobs × 1000-row Arrow batches) → bounded `writer_batch_size` |
| `c6e7444` | `FusionKernel` facade lacked `.producer` → CLI bank builds crashed per task (found as silent empty banks) |
| `8b503b5` | empty persisted bank (failed build) was loaded as authoritative → rebuild instead (`load_usable_bank`) |
| `15e4edd` | replay cache ignored the synthesis policy → select-best and rewrite could share cache entries |
| `70d0d1e` | bank build lost ALL paid panel calls on a crash (observed: $51 lost to an OOM while serializing a 4GB bank) → per-task build cache; provider failures dropped from banks instead of recorded as wrong answers |
| `8785761` | deep panels: candidate scoring now uses each model's primary sample (honest pass@1); adapter cache signature includes panel depth/policy |
| `b66f41b` | stage-payload pricing crashed the whole locked run (usage contract rejected extra keys); scoring failures no longer abort the batch |
| `c692be7` | shipped `.fusionkit/prompts/judge.md` was missing `best_trajectory` → select-best silently degraded to always-rewrite on the shipped path |

Measured-and-rejected (reverted with evidence): raising candidate truncation
1200→8000 chars — worse on BOTH families (`6577a9e`; artifacts
`phase6/*-trunc8000.json`).

Issues found, not fixed (documented for the roadmap): `doctor` exits 0
"ready" while the committed `.fusionkit/fusion.json` panel contains an
Apple-Silicon-only MLX member that cannot run on this host; HeuristicRouter
routes 100% of coding traffic to panel (no cost frontier); polyglot judge
accuracy 79%.

## Instrumentation added (Phase 2, all unit-tested)

Regret decomposition (judge-pick vs synthesis-rewrite, additive), judge
selection accuracy, `judge_best_trajectory` provenance, per-stage
(panel/judge/synth) usage/cost/latency through engine → adapter → bench
reports → external-run rows.

## Spend

`spend-ledger.jsonl` — estimates (solver-cost fields + pricing tables; panel
builds are metered, judge/synth replays estimated):

| phase | est. USD |
|---|---|
| 0–1 smoke + calibration | 0.9 |
| 3 baseline bank + replay | 11.2 |
| 4 ablations | 6.0 |
| 5 deep dev bank + climb (incl. $51 lost to the OOM'd build, recovered by the build-cache fix) | 115.0 |
| 6 locked test + shipped path + self baseline + polyglot + truncation ablation | 97.0 |
| **total** | **≈ $230 of $500** (never crossed the $410 tuning floor; $90 reserve honored) |

## Gate checklist (audit-skill objective)

1. Gate A evidence (locked split, uplift>0, p<0.05, real pipeline): **YES** —
   +18.6 pts, p<0.001, shipped-path check passed. (Rubric-strict Gate A wants
   n≥200 + a significant second family: roadmap item 1.)
2. Gate B evidence (oracle gap + regret split measured; default synthesis
   policy is the empirical winner): **YES**.
3. Rubric scoring sheet filled from artifacts: **YES** (`rubric-scorecard.md`).
4. Ranked roadmap for every criterion < 2: **YES** (`ROADMAP.md`).
5. Every bug fixed-with-test or filed with repro: **YES** (table above).
