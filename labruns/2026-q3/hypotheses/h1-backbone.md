---
hypothesis_id: h1-backbone
cycle: 2026-q3
status: ready
topology: parallel_judge
panel:
  - endpoint_id: ds32
    slug: deepseek/deepseek-v3.2
    provider: openrouter
    identity_hash: ae362c5b24c68089
    max_completion_tokens: 32768
  - endpoint_id: nemotron3s
    slug: nvidia/nemotron-3-super-120b-a12b
    provider: openrouter
    identity_hash: 3102a3dc361271e6
    max_completion_tokens: 32768
  - endpoint_id: dsv4pro
    slug: deepseek/deepseek-v4-pro
    provider: openrouter
    identity_hash: 4be9600ef13a12e9
    max_completion_tokens: 32768
judge:
  endpoint_id: qwen37max
  slug: qwen/qwen3.7-max
  identity_hash: 875cf3c729796c09
  is_panel_member: false
sampling:
  temperature: 0.2
  k_samples: 1
cost_projection:
  per_request_usd: 0.04854
  sweep_60_tasks_usd: 2.91259
prediction: "Beats the strongest single shortlist member by at least 2 pp on the calibration bank."
kill_condition: "H4 Self-MoA >= H1 on the same calibration bank; route, do not fuse."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H1 Backbone

This is the honest top-K backbone: the three highest ranked shortlist models
after applying the lineage veto are `deepseek/deepseek-v3.2` (rank 1),
`nvidia/nemotron-3-super-120b-a12b` (rank 2), and
`deepseek/deepseek-v4-pro` (rank 3). No bridge model or aggregate-null model is
used.

Vetoes applied: lineages are `deepseek-v3`, `nemotron-3-super`, and
`deepseek-v4`; all members have explicit 32k caps with 64k escalation entries
in the registry; providers are pinned in the snapshot to StreamLake, DeepInfra,
and DeepSeek respectively; panel-member cost is `$0.01479`, below the
`$0.08333` one-third GPT-5.5 anchor envelope.

Judge choice: `qwen/qwen3.7-max` is the common judge for H1, H2, and H5 because
it is a strong non-panel shortlist model with broad third-party evidence. It is
pinned to Alibaba in the snapshot, so there is no judge/panel overlap here.

Cost math: panel members use `2k input + 8k output` each:
`ds32 $0.0032032 + nemotron3s $0.0037600 + dsv4pro $0.0078300 =
$0.0147932`. The judge uses `15k input + 4k output`:
`$0.0187500 + $0.0150000 = $0.0337500`. Total per request is `$0.0485432`;
60 tasks cost `$2.912592`.

Falsification: if H4 ties or beats H1, the ensemble adds cost and complexity
without measured benefit. Shippable verdict if H1 wins: promote H1 as the
default fusion candidate for Phase C. Shippable verdict if H1 loses: route to
best-single or keep H1 only as a baseline.
