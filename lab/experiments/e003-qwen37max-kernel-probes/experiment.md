---
id: e003-qwen37max-kernel-probes
owner: alen
status: analyzed
benchmark: livecodebench
claim: "multi-sample and pair kernels on the qwen3.7-max frontier"
sweep_id: e003-qwen37max-kernel-probes
budget_usd: 65
spent_usd: 22
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
Rung 25 produced 119/125 result records; six exec shards were killed and eight
records were errors. Original complete-case scores were 14/20 exec, 15/22
exec+repair, 14/21 self-MoA, 16/22 judge-select, and 17/23 judge-synth.
Spend: $10.35 metered + ~$12 unmetered FusionKit estimate = ~$22 of $65.
Audit errata (2026-07-15): the 8 s grading wall caused false negatives;
`arc181_c`'s special judge inverted repair selection; r1's 16k cap crippled
both pair cells; candidate code was truncated to 1,200 characters before
judging; and errors/missing shards were omitted from reported denominators.
Most importantly, `selfmoa-q37-s3` was routed to `fusionkit/panel`, so it made
one q37 panel call rather than three self samples. It did not test self-MoA.
Retained exec artifacts show one clean oracle rescue (`abc371_f`) that the
public-test tie rule failed to select. Candidate bodies/judge traces were not
retained, so the remaining selection and synthesis regret is unknowable.

## Decision
Withdraw the no-headroom/capability-hard conclusion: no e003 compound family
received a valid, adequately observed test. Do not promote these cells or use
them as negative evidence. Re-test only after routing, evidence fidelity,
grading, failure denominators, and candidate retention are fixed.

## Follow-ups
- claimed: alen — correctness recovery and deterministic e2e tests before spend
- claimed: alen — plan-diverse q37 sampling plus tie-aware selection canary
- up-for-grabs — fresh, post-cutoff, non-special-judge development slice
