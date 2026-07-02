# Phase 5 — Hill climb (dev window only)

All tuning in this phase used the frozen dev manifest
(`dev-manifest.json`: 150 medium/hard stdin tasks, 2024-07-01 ≤ date <
2025-01-01). The ≥2025-01-01 window stayed locked and untouched.

## Tier assessment (from Phase 3/4 diagnosis)

Tier 1 (prompt climb) was measured as NOT the bottleneck: judge pick accuracy
is already 97–100%, synthesis regression ~1%, and total regret is *negative*
(the fused output beats the candidate pool's oracle). Prompts cannot buy much
when the pipeline is dropping ~0 points. The binding constraint was the
CANDIDATE POOL (oracle ceiling +7 pts over best single on 1-sample panels).
So the climb went straight to Tier 2 (config: pool depth + synthesis policy),
per the escalation heuristics in `fusion-hillclimb/reference.md`.

## Tier 2a — Deep panel (`panel_samples_per_model: 3`, temps 0.2/0.6/0.9)

New engine capability (commit `b477429`): panel mode generates a
temperature-varied pool per member (mirrors self-fusion; primary sample stays
at base temperature so per-model pass@1 baselines are apples-to-apples).
Deep dev bank: 150 tasks × 6 candidates (`dev-bank-deep.json`, per-task build
cache after commit `de0a48d`-era fix; dev tests capped at 8/task for memory).

| metric | shallow (1/member) | deep (3/member) |
|---|---|---|
| best single (primary) | opus 0.5133 | opus 0.5133 (same) |
| pool oracle | 0.5733 (derived) | **0.6533** |
| decision tasks | — | 48/150 |
| fused (rewrite) | 0.6333 | **0.6733** |
| fused (select-best) | — | **0.6733** |

Paired deep-select-best vs incumbent-shallow-rewrite on the same 150 dev
tasks: **7 wins / 1 loss** (χ²=3.125 — just under the 3.84 significance bar,
but +4.0 pts dev and strictly better vs-best-single wins profile:
24W/0L vs 26W/2L for shallow... see `shallow-vs-deep.json`). ACCEPTED as the
tuned benchmark-panel config (cost trade-off documented below); the locked
test in Phase 6 is the binding gate.

## Tier 2b — Synthesis policy default (4.1 closure)

On the deep dev bank (`dev-ablations-deep.json`):

| policy | dev pass@1 | vs best single | McNemar | synth regressions |
|---|---|---|---|---|
| judge-pick-verbatim | 0.6733 | +0.16 | **24W/0L χ²=22.0 sig** | 0 |
| LLM rewrite | 0.6733 | +0.16 | 26W/2L χ²=18.9 sig | 1 (1.1%) |
| exec-select (public tests) | 0.6133 | +0.10 | 19W/4L χ²=8.5 sig | — |

Judge-pick-verbatim ties rewrite on pass rate with a strictly cleaner
loss profile and skips the synthesizer call on ~71% of tasks (picks named
107/150) → `synthesis_select_best: true` is now the default in the tuned
benchmark panel config (`configs/benchmark-panel.gpt-opus-deep.yaml`). Its
no-pick fallback is the rewrite path, which rescued 5/150 dev tasks where
every candidate failed.

Judge quality on the deep bank: pick accuracy 100% (select-best replay),
strict exactly-one-correct 100%, picks named 71%. Judge JSON parse failures:
0 across all replays (~600 fuse calls to date).

## Shipped-path prompt fix

`.fusionkit/prompts/judge.md` (the committed override users get) was missing
the `best_trajectory` key — under it the judge never names a pick and
select-best silently degrades to always-rewrite. Updated to match the
built-in judge prompt (which the bank replays validated at 97–100% pick
accuracy).

## Cost note (Gate C)

Deep panel triples solver-candidate cost (~$0.34/task vs ~$0.113) but
select-best skips ~71% of synthesizer calls. Cost per SOLVED task (dev):
shallow-rewrite ≈ $0.17/0.6333 = $0.27; deep-select ≈ $0.36/0.6733 = $0.53 ≈
2.0× — inside the ≤2.5× beyond-frontier bound of rubric 7.1, with the shallow
config remaining the cost-preserving preset.

## Spend

- deep dev bank build: 150×6 samples ≈ $34 (+$51 lost to the OOM'd first
  attempt, already ledgered)
- dev replays (rewrite, select-best, shallow-rewrite, baseline CLI) ≈ $30
- Phase 5 total ≈ $64; cumulative ≈ **$133 of $500** (tuning floor $410 far off).
