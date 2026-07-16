---
id: e005-correctness-recovery-canary
owner: alen
status: proposed
benchmark: livecodebench
claim: "correctness-gated open-weight direction canary on a fresh hard dev cohort"
sweep_id: e005-correctness-recovery-canary
budget_usd: 24
spent_usd: 0
created: 2026-07-16
updated: 2026-07-16
---

## Hypothesis
A plan-diverse DSV4-Pro + Qwen3T pool has real oracle headroom on a fresh hard
dev cohort, and retained FusionKit evidence attributes the remaining loss to
generation, public selection, or synthesis without touching the holdout.

## Design
Five cells use verified MIT/Apache open weights on 24 content-locked spare tasks.
Rungs are 8/16/24: DSV4 solo, Qwen3T solo, heterogeneous N=4 exec+tie,
heterogeneous N=4 guarded repair, and Qwen3T self-MoA with retained inner evidence.
Requests pin provider, reasoning, seed, top-p, 64k output, one attempt, and v5's
official 6 s evaluator. Missing/error/drifted evidence blocks decisions.
Expected spend ~$18; hard ceiling $24; the separate $60 final reserve is untouched.

## Out of scope
Qwen3.7-Max, closed anchors, holdout evaluation, broad screening, prompt tuning,
population-level uplift/futility claims, and any run before PR #118 is merged.

## Decision rule
Promote 8→16 only with complete provenance/evidence, zero harness faults, no
truncation, best-solo 2–6/8, and projected spend <=$24. Promote 16→24 only if
oracle headroom, selection regret, tie rescue, or synthesis damage is nonzero.
At 24 expand only the largest observed loss axis; otherwise stop inconclusive.

## Results

## Decision

## Follow-ups
- claimed: alen — locked-holdout final only after a valid recovery direction
