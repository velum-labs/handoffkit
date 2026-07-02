# Phase 4 — Ablation battery (frozen bank, replay-only)

- script: `run_ablations.py` (committed in this directory); raw output `ablations.json`
- bank: the 86-task ≥2025-01-01 bank (`bank-slim.json` in phase3/), stock panel
  config, stock prompts, seed-0 replays via `TunerRuntime`/`JudgeSynthesizer`
  (the real fusion pipeline over frozen candidates).
- No new panel calls; judge+synth replays + local execution only.

## 4.1 Synthesis policy ablation (same candidates, same judge)

| policy | pass@1 (n=86) | vs best single gpt 0.4767 | McNemar | significant |
|---|---|---|---|---|
| **LLM rewrite (shipped default)** | **0.5698** | **+0.0930** | 8W/0L, χ²=6.125 | **yes** |
| judge-pick-verbatim (`synthesis_select_best`) | 0.5698 | +0.0930 | 8W/0L, χ²=6.125 | yes |
| exec-select (public→private, pool=2) | 0.5581 | +0.0814 | 7W/0L, χ²=5.14 | yes |

Rewrite and select-best tie exactly on this pool; exec-select is 1 task behind
(with only 2 candidates the public-test filter has little to choose from).
**The shipped default (rewrite) is the empirical winner at pool=2** — and it is
the only policy that can rescue tasks where every candidate failed.

## 3.1/3.2 Judge quality (from the same replays)

- Judge picks named: 48/86; **decision-task pick accuracy 1.0** (strict
  exactly-one-correct also 1.0). The gpt-5.5 judge never named a failing
  candidate when a passing one existed.
- Regret split (rewrite policy): total regret **−0.0233** (negative:
  fused > candidate oracle) = judge −0.0233 + synthesis **0.0000**.
- **4.2 synthesis regression rate: 0.0** — zero tasks where the judge picked a
  passing candidate and the rewrite ruined it. Instead the rewrite **rescued 2
  tasks where BOTH candidates failed** (`abc394_e`, `arc192_d`) — the
  synthesizer produced genuinely better-than-panel code.
- Judge JSON parse failures: 0 observed in any replay (rubric 3.3 evidence so
  far; no constrained-decoding work needed yet).

## 2.3 Leave-one-out member value (selection-oracle, from bank flags)

| member | solo pass@1 | oracle without it | marginal oracle value |
|---|---|---|---|
| gpt (gpt-5.5) | 0.4767 | 0.4419 | **+0.1047** |
| opus (claude-opus-4-8) | 0.4419 | 0.4767 | **+0.0698** |

Both members pay for themselves (≥ +1 point) — panel composition justified.

## 5.1 Router vs trivial policies (from bank scores; costs are Phase-1-calibrated estimates)

| policy | pass@1 | est. cost/task |
|---|---|---|
| never-fuse (gpt) | 0.4767 | ~$0.036 |
| always-fuse (rewrite) | 0.5698 | ~$0.17 |
| HeuristicRouter | 0.5698 | ~$0.17 (routed 100% to fuse) |

The keyword router sends every LCB task to the panel ("code" keyword) — it is
a no-op on this workload; no cost-quality frontier yet (roadmap item 5.2).

## Headline (baseline, stock config, full 86-task window)

Fused 0.5698 vs best single 0.4767 → **+9.3 pts, McNemar 8-0 (χ²=6.125,
p<0.05)** on the full available post-2025-01-01 LCB window, through the real
judge+synthesis pipeline. This is a baseline measurement (nothing was tuned on
these tasks — stock prompts/config, single replay per policy).

## Split discipline going forward (Gate D)

The ≥2025-01-01 window (86 tasks) is hereby **LOCKED as the Phase-6 test set**.
All Phase-5 tuning (prompts, config, policy confirmation) happens on the
older, disjoint 2024-07-01..2024-12-31 window (150 problems) via a frozen
manifest. The final incumbent is evaluated ONCE on the locked window in
Phase 6 with fresh candidate generation through the public-bench adapter.

## Contamination note (honesty)

Both panel models are 2026-era; LCB release_v6 ends 2025-05, so no window in
the pinned dataset is strictly post-training-cutoff for them. Absolute rates
(gpt 47.7% on medium/hard) suggest the tasks are far from memorized. All
claims here are same-harness fused-vs-best-single deltas, where contamination
affects both sides equally; leaderboard comparisons are out of scope.

## Spend

Rewrite replay ≈ $4.0, select-best replay (judge-only) ≈ $2.0; exec-select $0
(local). Phase 4 ≈ **$6**; cumulative ≈ **$18.1 of $500**.
