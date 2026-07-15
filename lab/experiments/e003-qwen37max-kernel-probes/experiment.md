---
id: e003-qwen37max-kernel-probes
owner: alen
status: locked
benchmark: livecodebench
claim: "multi-sample and pair kernels on the qwen3.7-max frontier"
sweep_id: e003-qwen37max-kernel-probes
budget_usd: 65
spent_usd: 0
created: 2026-07-14
updated: 2026-07-14
---

## Hypothesis
Execution-guided multi-sampling on qwen3.7-max beats its own solo rate on the
dev slice, and at rung 60 the best kernel beats the GPT-5.5 anchor on paired
tasks — rung 3 of the ladder, since e002 showed zero solo headroom.

## Design
Five kernel cells, all on the e002 frontier: exec-select n=3, exec-select with
repair, self-MoA (3 samples at temperature 0.8), judge-select and judge-synth
on the qwen3.7-max + r1 pair (union 76.3% in e002). All cells pin the full
110-task dev-manifest hash; kernels enter at rung 25 (~$50 estimated) and only
survivors are promoted to rung 60 (~$40). Backend aws-batch on
`hypergrid-batch-runner:8`; every multi-call cell runs attempts=2 with an
1800 s deadline. Solo and anchor baselines are read from the e002 store —
never re-billed. exec-select n=5 is reserved for a within-question extend.

## Out of scope
Panels beyond the q37+r1 pair (Wilson-dominated in e002), prompt tuning,
exec-tie-judge hybrids (needs an adapter change; only if exec-select shows
tie-losses), any holdout evaluation, and anchor re-runs.

## Decision rule
Promote to rung 60 only kernels whose rung-25 rate is at or above solo
qwen3.7-max on the same 25 tasks. Conclude on the best kernel's paired
McNemar vs the anchor at rung 60. If no kernel clears solo at rung 25, stop:
fusion has no headroom on this slice and the next proposal re-scopes the
benchmark instead.

## Results

## Decision

## Follow-ups
