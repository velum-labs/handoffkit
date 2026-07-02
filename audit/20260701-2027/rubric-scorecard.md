# Rubric scorecard — audit 20260701-2027

Scored per `docs/fusion/FUSION_VALUE_RUBRIC.md` (0 absent / 1 present / 2 met).
Every non-zero score cites the artifact it was read from (paths relative to
`audit/20260701-2027/`). Unmeasured = 0. Final incumbent under test:
`configs/benchmark-panel.gpt-opus-deep.yaml` (GPT-5.5 + Opus 4.8, 3
temperature-varied samples each, judge=gpt, select-best synthesis) at git
`6577a9e`-era source.

## 1. Headline uplift [20]

| # | score | evidence |
|---|---|---|
| 1.1 | 1 | LCB locked window (86 tasks = FULL available ≥2025-01-01 medium/hard stdin pool, evaluated once, real `FusionEngine` pipeline): fused 0.6628 vs best single opus 0.4767, **+18.6 pts, McNemar 16W/0L χ²=14.06 p<0.001** — `phase6/locked-test.jsonl`. Below 2 only because n=86 < the 200-task bar and LCB is single-shot, not an agentic gateway suite. |
| 1.2 | 1 | Second family (Aider-polyglot adaptation, 103 exercises, python/go/rust, config frozen before first contact): fused 0.7767 vs best single 0.7670, +0.97 pt, 7W/6L, **not significant** — `phase6/poly-full-eval.json`. |
| 1.3 | 2 | +18.6 pts absolute on 1.1's benchmark (≥ +3 required) — `phase6/locked-test.md`. |
| 1.4 | 2 | No benchmark where best single beats compound at p<0.05: polyglot 7W/6L ns; LCB fused wins; shipped-path gateway 0W/1L ns — `phase6/poly-full-eval.json`, `phase6/shipped-path-check.json`. |
| 1.5 | 0 | No ≥3-seed aggregation run (Wilson CIs only). |
| 1.6 | 0 | No non-coding suite measured. |

## 2. Ensemble headroom [10]

| # | score | evidence |
|---|---|---|
| 2.1 | 2 | Oracle gap per bank: +7.0 (shallow locked-window), **+14.0** (deep dev), +8.7 (polyglot) — `phase3/phase3-baseline.md`, `phase5/phase5-hillclimb.md`, `phase6/poly-full-eval.json`. Ceiling ≥ +5 → panel redesign (deep pool) done from this data. |
| 2.2 | 2 | Mean pairwise failure correlation 0.65 (shallow) / 0.61 (deep dev); fed the panel-depth decision — `phase3/phase3-baseline.md`, `phase5/`. |
| 2.3 | 2 | Leave-one-out marginal oracle value: gpt +8.0 pts, opus +7.3 pts (deep dev; +10.5/+7.0 shallow) — both pay for themselves — `phase5/dev-ablations-deep.json`. |
| 2.4 | 2 | Two families by default; composition justified by LOO + self-mode ablation under the two-provider constraint — `phase6/self-ablations.json`. |
| 2.5 | 2 | Panel (2×3 samples) vs self-mode (gpt×6, matched pool): 0.6733 vs 0.6133, **+6.0 pts, 11W/2L χ²=4.92 significant** — `phase6/self-ablations.json` + `phase5/dev-ablations-deep.json`. |

## 3. Judge quality [12]

| # | score | evidence |
|---|---|---|
| 3.1 | 2 | Decision-task pick accuracy: LCB shallow 1.00 (48 picks), LCB deep 0.97–1.00 (107 picks), polyglot 0.79 (89 picks) — ≥70% everywhere, reported per class — `phase4/ablations.json`, `phase5/dev-ablations-deep.json`, `phase6/poly-full-eval.json`. |
| 3.2 | 1 | Regret split instrumented on every run (commit `3577ffb`): LCB total regret ≤0 (fused ≥ pool oracle); polyglot judge regret **7.8 pts > 5-pt bar** — `phase6/poly-full-eval.json`. |
| 3.3 | 1 | Judge JSON parse failures: **0 across ~900+ fuse calls** (all replays + locked run aggregates); failures surfaced via `judge_parse_failures`/failure kind when they occur. Constrained decoding + retry not implemented (no empirical need observed). |
| 3.4 | 0 | No calibration curve. |
| 3.5 | 0 | No judge-tier ablation (judge=gpt-5.5 throughout). |
| 3.6 | 2 | `FusionAnalysis` structured comparison preserved into synthesis; pinned by `tests/test_judge.py` (incl. new `judge_best_trajectory` metric). |

## 4. Synthesis policy [12]

| # | score | evidence |
|---|---|---|
| 4.1 | 2 | Rewrite vs pick-verbatim vs exec-select ablated on both families; winner (select-best, tie on pass rate + 0 losses + ~71% fewer synth calls) **is now the default** (`config.py synthesis_select_best=True`, commit with `test_synthesis_select_best_is_the_default_policy`) — `phase4/ablations.json`, `phase5/dev-ablations-deep.json`. |
| 4.2 | 2 | Synthesis regression rate: 0% (LCB shallow), 1.1% (LCB deep dev), 0% (polyglot select-best) — all < 5% — same artifacts. |
| 4.3 | 0 | Execution grounding not on the live gateway path (eval harness only). |
| 4.4 | 1 | Trajectory items consumed by prompts; content-quantity ablation done (truncation 1200 vs 8000 — more content measured worse); no items-vs-content-only ablation. |
| 4.5 | 1 | Single-writer by construction (worktree isolation in harness layer); not re-verified by a dedicated regression test in this audit. |
| 4.6 | 1 | `selected_trajectory_id` + rationale + `judge_best_trajectory` recorded per fused turn; not surfaced in a dashboard. |

## 5. Routing & adaptivity [12]

| # | score | evidence |
|---|---|---|
| 5.1 | 1 | Router vs always-fuse vs never-fuse computed: HeuristicRouter routes 100% of coding tasks to panel → equals always-fuse (0.5698 @ ~$0.17/task) vs never-fuse 0.4767 @ ~$0.036 — no cost frontier — `phase4/ablations.json`. |
| 5.2 | 0 | No learned router. |
| 5.3 | 0 | No escalation mode. |
| 5.4 | 0 | Fixed panel depth (no difficulty-adaptive tiers). |
| 5.5 | 1 | Per-turn routing exists with reasons logged in trace; adaptivity not measured. |
| 5.6 | 1 | Two named presets now exist with measured dev frontiers (shallow ≈1.8× cost/solve of best single; deep ≈2.0×) — `phase5/phase5-hillclimb.md`; not formal product modes. |

## 6. Agentic mechanics [10]

| # | score | evidence |
|---|---|---|
| 6.1 | 0 | Staleness not measured. |
| 6.2 | 0 | Tool-call fidelity not measured on real harness runs. |
| 6.3 | 1 | Isolation/shared-memory by construction; not pinned by dedicated tests in this audit. |
| 6.4 | 2 | Truncation limits ablated with billed runs (1200 vs 8000 on both families; 1200 measured better and kept, now a named constant busting replay caches) — `phase6/poly-full-eval-trunc8000.json`, `phase6/dev-ablations-trunc8000.json`, commit `6577a9e`. |
| 6.5 | 0 | No multi-turn benchmark (Docker absent → Terminal-Bench-class out of scope; noted). |
| 6.6 | 0 | Failover quality delta not measured. |

## 7. Cost & latency economics [10]

| # | score | evidence |
|---|---|---|
| 7.1 | 1 | Cost per solved task measured on the locked run: fused $25.24/57 = $0.44/solve vs opus-alone ≈$0.16/solve → **≈2.8×** (bar ≤2.5×); shallow preset ≈1.8× on dev — `phase6/locked-test-rows-with-stages.json`. |
| 7.2 | 1 | Per-stage latency instrumented: locked run p50/p95 — panel 69.5/83.3s, judge 16.1/42.5s, task total 95/182s (≈2.2× panel-stage p95 proxy); measured at the engine, not gateway p95 — same artifact. |
| 7.3 | 0 | No hedging/quorum. |
| 7.4 | 0 | No provider prompt caching. |
| 7.5 | 0 | Pre-spend budget gate untested. |
| 7.6 | 1 | Judge/synth token overhead tracked per turn (stage metrics); trimming ablated (6.4); no session-growth analysis. |

## 8. Reliability [6]

| # | score | evidence |
|---|---|---|
| 8.1 | 1 | Failed members → failed trajectories (tested); bank builder now drops failed generations rather than mis-scoring them (commit `de0a48d`-era fix + test); no injected-failure soak. |
| 8.2 | 1 | `PanelExhaustedError` + empty-synth fallback tested; judge/synth provider-failure chaos test absent. |
| 8.3 | 1 | Frozen banks + per-task caches make every bench task replayable offline (used throughout); full wire-capture replay not exercised here. |
| 8.4 | 0 | No renamed-model drill. |
| 8.5 | 0 | No concurrency soak in CI. |

## 9. Measurement integrity & loop [8]

| # | score | evidence |
|---|---|---|
| 9.1 | 1 | Frozen dev manifest (`phase5/dev-manifest.json`) + locked ≥2025-01-01 window declared in `phase4/phase4-ablations.md` BEFORE tuning and evaluated once; enforced by process/artifacts, not by tooling that physically hides holdout. |
| 9.2 | 1 | `bench_history` ledger with drift detection, multiple comparable runs this audit; no schedule. |
| 9.3 | 2 | Hill-climb loop produced a significant held-out improvement end-to-end: shallow baseline (+9.3 dev-window evidence) → deep+select-best tuned on dev only → locked test **+18.6 significant** — `phase3/` → `phase5/` → `phase6/`. |
| 9.4 | 0 | Outcome records feed no learned component. |
| 9.5 | 0 | Pool-refresh playbook not exercised. |
| 9.6 | 2 | All claims same-harness with provenance (git SHA, model versions, dataset revision, seeds) in every envelope; `public_claim_eligible`/disclaimer machinery intact; contamination caveat documented (`phase4/phase4-ablations.md`). |
| 9.7 | 0 | No dashboards. |

## 10. Architecture headroom [4]

| # | score | evidence |
|---|---|---|
| 10.1 | 0 | Default gateway flow not through registered kernel workflows end-to-end. |
| 10.2 | 0 | MoA / exec-select-repair not runnable via workflow ids in fusion-bench. |
| 10.3 | 0 | No scheduler-seam shipment. |
| 10.4 | 0 | No learned-orchestration design doc. |

## Totals

| Dim | weight | criterion scores | dim score |
|---|---|---|---|
| 1 Headline uplift | 20 | 1,1,2,2,0,0 (6/12) | 10.0 |
| 2 Ensemble headroom | 10 | 2,2,2,2,2 (10/10) | 10.0 |
| 3 Judge quality | 12 | 2,1,1,0,0,2 (6/12) | 6.0 |
| 4 Synthesis policy | 12 | 2,2,0,1,1,1 (7/12) | 7.0 |
| 5 Routing | 12 | 1,0,0,0,1,1 (3/12) | 3.0 |
| 6 Agentic mechanics | 10 | 0,0,1,2,0,0 (3/12) | 2.5 |
| 7 Cost & latency | 10 | 1,1,0,0,0,1 (3/12) | 2.5 |
| 8 Reliability | 6 | 1,1,1,0,0 (3/10) | 1.8 |
| 9 Measurement & loop | 8 | 1,1,2,0,0,2,0 (6/14) | 3.4 |
| 10 Architecture | 4 | 0,0,0,0 (0/8) | 0.0 |
| **Total** | **104** | | **46.2** |

## Hard gates

- **Gate A** (1.1 + 1.2 at 2, 1.4 holds): **NOT PASSED rubric-strict** — 1.4
  holds and the locked LCB result is significant (+18.6, p<0.001, real
  pipeline, shipped-path-validated), but 1.1 is n=86 (<200) single-shot and
  1.2 (polyglot) is positive-but-not-significant. The audit-skill objective
  item 1 (locked-split win through the real pipeline) **is met**.
- **Gate B** (regret split + oracle gap measured; default policy is the
  empirical winner): **PASSED** — 3.2/2.1 instrumented and measured on every
  run; 4.1 winner (select-best) is the shipped default.
- **Gate C** (7.1+7.2 within thresholds + hedging or caching): **NOT PASSED**
  — economics measured but deep preset is 2.8× cost/solve and neither 7.3 nor
  7.4 is shipped.
- **Gate D** (9.1, 9.2, 9.6 at 2): **NOT PASSED** — 9.6 at 2, but locked-split
  discipline and repeatable bench are process-enforced (1), not tool-enforced.
