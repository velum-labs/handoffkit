---
hypothesis_id: h1-backbone
cycle: 2026-q3
status: ready
topology: panel
fusionkit_config: configs/benchmark-panel.h1-backbone.yaml
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
  endpoint_id: ds32
  slug: deepseek/deepseek-v3.2
  identity_hash: ae362c5b24c68089
  is_panel_member: true
synthesizer:
  endpoint_id: ds32
  slug: deepseek/deepseek-v3.2
  identity_hash: ae362c5b24c68089
  is_panel_member: true
sampling:
  temperature: 0.2
  k_samples: 1
cost_projection:
  per_request_usd: 0.01479
  sweep_60_tasks_usd: 0.88759
prediction: "Beats the strongest single shortlist member by at least 2 pp on the calibration bank."
kill_condition: "best-single >= H1 on the calibration bank; route, do not fuse."
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

FusionKit shape: standard parallel panel → judge → synthesizer. Judge and
synthesizer are `deepseek/deepseek-v3.2` (`ds32`), the strongest panel member
(rank 1). Judge selection is constrained to the panel for this cycle.

Phase B config: `configs/benchmark-panel.h1-backbone.yaml` (same shape as
`configs/benchmark-panel.gpt-opus.yaml`).

Cost math: panel members use `2k input + 8k output` each:
`ds32 $0.0032032 + nemotron3s $0.0037600 + dsv4pro $0.0078300 =
$0.0147932`. Judge/synthesis adds an incremental call on `ds32` (not modeled in
the front-matter estimate); 60 panel-generation tasks cost `$0.887592`.

Falsification: if best-single ties or beats H1, the ensemble adds cost and
complexity without measured benefit. Shippable verdict if H1 wins: promote H1 as
the default fusion candidate for Phase C. Shippable verdict if H1 loses: route
to best-single or keep H1 only as a baseline.
