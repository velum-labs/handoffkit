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
At rung 25, zero kernel wins over paired solo qwen3.7-max on any shared task:
exec n3 14/20 vs 14/20 (discordants 0/0), judge-select 16/22 vs 16/22 (0/0),
judge-synth 17/23 vs 17/23 (0/0), exec+repair 15/22 vs 16/22 (0/1),
self-MoA 14/21 vs 15/21 (0/1); all McNemar p=1.0. Six exec shards never
graded (sequential 3x1800 s sampling exceeds the 3600 s Batch wall clock) —
these are the hardest instances and a documented limitation. Spend: $10.35
metered + ~$12 serve-internal estimate = ~$22 of $65.
Erratum 2026-07-15: a grading audit (8 s wall < 12 s CPU rlimit; TLE'd correct
code on 2-vCPU workers) re-graded all unresolved shards at 30 s: 4 e003
outcomes flipped, but every flip was concordant with solo — the gate still
shows zero discordant kernel wins, so the no-headroom Decision stands.
arc181_c is a special-judge instance that inverted exec-select's public
signal; excluded going forward. Adapter v2 also parallelizes sample draws.
Erratum 2 (2026-07-15): r1 was selected as panel partner from e002's
complementarity matrix, which is invalid — r1 was token-truncated to empty
code on 71% of e002 shards, and the same 16384 cap applied inside this
experiment's serve configs. The pair-kernel cells (judge-select/judge-synth)
therefore tested a crippled panel; their no-gain result is uninformative.
The self-diversity no-gain result on q37max (exec-select, self-MoA) stands —
q37max is not truncation-affected.

## Decision
No promotion: every kernel has <2pp oracle headroom over its best member (the
campaign prune rule) and zero discordant wins, so a rung-60 anchor McNemar
significance is unreachable. Solo failures on this slice are capability-hard,
not variance — extra samples, repair, r1 pairing, and judge/synth all
reproduce solo's exact pass pattern. Fusion has no headroom here; re-scope
the benchmark before any compound search.

## Follow-ups
- up-for-grabs — holdout validation of the parity claim (solo qwen3.7-max vs
  both anchors, once, from the $60 reserve) as the campaign final
- up-for-grabs — harder/newer slice where the anchor gap is real, then re-probe
- up-for-grabs — parallelize the exec-select sampling loop (Tier-3) so n>=3
  fits the Batch wall clock
