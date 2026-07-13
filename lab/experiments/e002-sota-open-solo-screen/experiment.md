---
id: e002-sota-open-solo-screen
owner: alen
status: locked
benchmark: livecodebench
claim: "SOTA anchors and open-weight solo floor on the hypergrid dev slice"
sweep_id: e002-sota-open-solo-screen
budget_usd: 65
spent_usd: 0
created: 2026-07-13
updated: 2026-07-13
---

## Hypothesis
At least one open-weight solo lies within 25 percentage points of the best
closed SOTA anchor without making the slice saturated within 2 points.

## Design
Freeze 13 solo cells: GPT-5.5 and Opus 4.8 anchors plus 11 open-weight models.
All cells pin the full 110-task dev-manifest hash for later shard reuse.
Plan 1,430 shards; submit anchors at rung 60 and open solos at rung 110
(1,330 billed shards) using `--backend aws-batch`.
Use bucket `hypergrid-batch-052777341990-us-east-1`, queue
`hypergrid-batch-queue`, and job definition `hypergrid-batch-runner:1`.
The lost e001 workdir has no reusable raw baseline; its accepted re-spend is
documented in the retrospective. Anchors remain solo-only and frozen.

## Out of scope
Fused cells, kernel probes, prompt tuning, compound search, and the locked
holdout. Those belong to e003-e005 and must read this experiment's store.

## Decision rule
If the best open solo trails the best anchor by >25pp, re-scope the dev slice
before kernel probes. If the gap is <2pp, declare the slice saturated.
Otherwise select the top two complementary open solos by paired union coverage,
subject to the lineage veto, and propose e003. Investigate errors before reruns.

## Results

## Decision

## Follow-ups
- claimed: alen — e003 kernel probes, conditional on this screen
