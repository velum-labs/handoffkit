---
hypothesis_id: h5-thinking-heavy
cycle: 2026-q3
status: smoke_passed
topology: panel
fusionkit_config: configs/benchmark-panel.h5-thinking-heavy.yaml
panel:
  - endpoint_id: ds32_64k
    slug: deepseek/deepseek-v3.2
    provider: openrouter
    identity_hash: 5dad17a15040bab6
    max_completion_tokens: 65536
  - endpoint_id: kimi26_64k
    slug: moonshotai/kimi-k2.6
    provider: openrouter
    identity_hash: c37e26715923e709
    max_completion_tokens: 65536
  - endpoint_id: nemotron3s_64k
    slug: nvidia/nemotron-3-super-120b-a12b
    provider: openrouter
    identity_hash: e24be69e14a8b224
    max_completion_tokens: 65536
judge:
  endpoint_id: ds32_64k
  slug: deepseek/deepseek-v3.2
  identity_hash: 5dad17a15040bab6
  is_panel_member: true
synthesizer:
  endpoint_id: ds32_64k
  slug: deepseek/deepseek-v3.2
  identity_hash: 5dad17a15040bab6
  is_panel_member: true
sampling:
  temperature: 0.2
  k_samples: 1
cost_projection:
  per_request_usd: 0.08060
  sweep_60_tasks_usd: 4.83606
prediction: "Beats H1 on the hard-difficulty task slice where 64k reasoning budgets matter."
kill_condition: "H5 <= H1 on the full calibration bank; drop the 64k reasoning bet."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H5 Thinking-Heavy

This optional hypothesis uses two reasoning-class members plus one fast
generalist at explicit 64k completion caps: `deepseek/deepseek-v3.2` (rank 1),
`moonshotai/kimi-k2.6` (rank 8), and
`nvidia/nemotron-3-super-120b-a12b` (rank 2). Separate 64k registry endpoint IDs
are used because the identity hash includes `max_completion_tokens`.

Vetoes applied: lineages are `deepseek-v3`, `kimi-k2`, and
`nemotron-3-super`; every member has a 64k cap; providers are pinned in the
snapshot to StreamLake, Decart, and DeepInfra; panel-member cost is
`$0.08060`, just below the `$0.08333` one-third GPT-5.5 anchor envelope.

FusionKit shape: standard parallel panel → judge → synthesizer. Judge and
synthesizer are `ds32_64k` (strongest panel member). Judge selection is
constrained to the panel for this cycle.

Phase B config: `configs/benchmark-panel.h5-thinking-heavy.yaml`.

Cost math: the two reasoning members use `2k input + 20k output`: `ds32_64k
$0.0073216 + kimi26_64k $0.0695200`. The fast generalist keeps the non-thinking
expected output assumption despite the 64k cap: `nemotron3s_64k $0.0037600`.
Total panel generation per request is `$0.0806016`; 60 tasks cost `$4.836096`.

Falsification: if H5 does not beat H1, the extra output budget is not buying
enough hard-task lift. Shippable verdict if H5 wins: keep a 64k reasoning lane
for hard tasks. Shippable verdict if it loses: use 32k panels and reserve 64k
only for truncation escalations.
