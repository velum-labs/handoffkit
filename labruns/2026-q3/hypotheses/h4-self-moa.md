---
hypothesis_id: h4-best-single-baseline
cycle: 2026-q3
status: baseline_metric
topology: n/a
panel: []
judge:
  endpoint_id:
  slug:
  identity_hash:
  is_panel_member: false
sampling:
  temperature:
  k_samples: 1
cost_projection:
  per_request_usd: 0.00320
  sweep_60_tasks_usd: 0.19219
prediction: "Mandatory comparison: best-single panel member pass rate sets the routing bar for all panels."
kill_condition: "If best-single >= all panels, ship a routing verdict instead of a fusion verdict."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H4 Best-Single Baseline (metric, not a config)

This is the mandatory honesty baseline. It is **not** a separate FusionKit
ensemble config and does not use Self-MoA or `exec_select` topology.

Phase C measures it automatically: for each panel hypothesis, `fusion_bench` /
`fusion_compound` reports **best-single** pass rate (the strongest panel member
alone on the same tasks) alongside the fused score. The reference member is
`deepseek/deepseek-v3.2` (rank 1, aggregate `83.30`) — the expected best-single
across H1/H2/H5 because `ds32` is in every panel.

Cost math (reference only): one `ds32` sample at `2k input + 8k output` costs
`$0.0032032`; 60 tasks cost `$0.192192`.

Falsification: best-single is not killed for being strong; it falsifies the need
for fusion if it matches or beats every panel. Shippable verdict if best-single
wins: publish a routing preset instead of a fused panel. Shippable verdict if it
loses: promote the winning panel.
