---
hypothesis_id: h3-cheap-cascade
cycle: 2026-q3
status: out_of_scope
topology: cascade
panel:
  - endpoint_id: nemotron3s
    slug: nvidia/nemotron-3-super-120b-a12b
    provider: openrouter
    identity_hash: 3102a3dc361271e6
    max_completion_tokens: 32768
  - endpoint_id: ds32
    slug: deepseek/deepseek-v3.2
    provider: openrouter
    identity_hash: ae362c5b24c68089
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
sampling:
  temperature: 0.2
  k_samples: 1
cost_projection:
  per_request_usd: 0.02167
  sweep_60_tasks_usd: 1.30040
prediction: "Achieves at least 80% of H1 pass rate at no more than 40% of H1 cost."
kill_condition: "Escalation rate > 60%; cascade saves too little to justify the wrapper."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H3 Cheap-First Cascade

**Out of scope for this cycle.** FusionKit's shipped ensemble path is parallel
panel → judge → synthesizer only. Cascade (cheap-first, escalate on failure) is
not implemented in the product or benchmark harness. This card is retained as a
future product bet; do not block H1/H2/H5 on it.

Original intent: `nvidia/nemotron-3-super-120b-a12b` answers first; on grading
failure, escalate to the H1 panel with judge `ds32`. Revisit when FusionKit
gains a cascade topology.
