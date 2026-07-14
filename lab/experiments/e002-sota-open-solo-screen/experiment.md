---
id: e002-sota-open-solo-screen
owner: alen
status: analyzed
benchmark: livecodebench
claim: "SOTA anchors and open-weight solo floor on the hypergrid dev slice"
sweep_id: e002-sota-open-solo-screen
budget_usd: 65
spent_usd: 52.40
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
qwen3.7-max 78/106 = 73.6% [64.3%, 81.1%]; GPT-5.5 anchor 44/60 = 73.3%
[61.0%, 82.9%]; on 56 shared graded tasks the paired McNemar p = 1.0.
Opus 4.8 30/60 = 50.0% [37.7%, 62.3%]. Next open solos: dsv4pro and qwen3t
both 37.3%; the rest 13.6-32.7%, all Wilson-dominated by qwen3.7-max.
Residual errors: 15/1,430 provider timeouts after retries (10 on r1).
Actual spend $52.40 of $65. Grafana run_id e002-sota-open-solo-screen;
store s3://hypergrid-batch-052777341990-us-east-1/runs/e002-sota-open-solo-screen/.

## Decision
The <2pp saturation rule fired at the floor: qwen3.7-max is at GPT-5.5 parity
on this slice, so anchor-gap headroom for fusion is ~0 and panel breadth is
unjustified. e003 should probe multi-sample kernels on qwen3.7-max (self
diversity) with r1 as the only complementarity-motivated partner
(union 76.3% vs 75.3% solo).

## Follow-ups
- claimed: alen — e003 kernel probes on qwen3.7-max (+r1 pair), conditional on merge
- up-for-grabs — harder or newer LCB slice where the anchor gap is real
