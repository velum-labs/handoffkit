---
hypothesis_id: h4-self-moa
cycle: 2026-q3
status: ready
topology: exec_select
panel:
  - endpoint_id: ds32
    slug: deepseek/deepseek-v3.2
    provider: openrouter
    identity_hash: ae362c5b24c68089
    max_completion_tokens: 32768
judge:
  endpoint_id:
  slug:
  identity_hash:
  is_panel_member: false
sampling:
  temperature: 0.7
  k_samples: 3
cost_projection:
  per_request_usd: 0.00961
  sweep_60_tasks_usd: 0.57658
prediction: "Mandatory baseline: best-of-3 DeepSeek V3.2 samples set the routing bar for all panels."
kill_condition: "If H4 >= all panels, ship a routing verdict instead of a fusion verdict."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H4 Self-MoA Baseline

This is the mandatory honesty baseline: the strongest single shortlist member,
`deepseek/deepseek-v3.2` (rank 1, aggregate `83.30`), sampled three times with
execution-guided selection and no judge.

Vetoes applied: a one-member panel has no lineage conflict; `ds32` has a 32k cap
with a 64k escalation entry in the registry; StreamLake is pinned in the
snapshot; three samples cost `$0.00961`, below H1's full judged request cost.

Judge choice: none. Selection is execution-guided, so no synthesizer can bias
toward its own answer style.

Cost math: one `ds32` sample at `2k input + 8k output` costs
`$0.0032032`. K=3 costs `3 * $0.0032032 = $0.0096096`; 60 tasks cost
`$0.576576`.

Falsification: H4 is not killed for being strong; it falsifies the need for
fusion if it matches or beats every panel. Shippable verdict if H4 wins:
publish a routing preset instead of a fused panel. Shippable verdict if it
loses: keep it as the baseline for Phase C and promote the winning panel.
