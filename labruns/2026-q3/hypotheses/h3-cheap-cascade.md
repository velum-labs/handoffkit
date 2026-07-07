---
hypothesis_id: h3-cheap-cascade
cycle: 2026-q3
status: deferred
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
  endpoint_id: qwen37max
  slug: qwen/qwen3.7-max
  identity_hash: 875cf3c729796c09
  is_panel_member: false
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

This card is complete but deferred because the cascade wrapper is not built.
`nvidia/nemotron-3-super-120b-a12b` is the cheapest competent shortlist member:
rank 2 aggregate `81.20`, `$0.08/M` input, and `$0.45/M` output. It answers
first.

Escalation rule: accept the cheap answer only if deterministic grading passes
or, before grading is available, if the answer does not self-report uncertainty
and contains a complete runnable solution. On grading failure, self-reported
low confidence, truncation, or malformed output, reuse the Nemotron answer and
escalate by calling the remaining H1 members plus the common judge.

Vetoes applied: the escalated panel has `nemotron-3-super`, `deepseek-v3`, and
`deepseek-v4` lineages; all members have explicit 32k caps with 64k escalation
entries; providers are pinned to DeepInfra, StreamLake, and DeepSeek; the
full-escalation panel-member cost remains `$0.01479`, below the `$0.08333`
one-third GPT-5.5 anchor envelope.

Judge choice: the common `qwen/qwen3.7-max` judge is pinned to Alibaba and is
not a panel member.

Cost math: cheap-only cost is `nemotron3s $0.0037600`. Full escalation reuses
that answer and adds `ds32 $0.0032032 + dsv4pro $0.0078300 + judge $0.0337500`,
for `$0.0485432`. The front matter uses the target blended projection at a
40% escalation rate: `$0.0037600 + 0.40 * ($0.0032032 + $0.0078300 +
$0.0337500) = $0.0216733`; 60 tasks cost `$1.3003968`.

Falsification: if escalation exceeds 60%, the cascade is mostly H1 with added
latency. Shippable verdict if it wins: build the wrapper and optimize $/solve.
Shippable verdict if it loses: keep parallel panels and do not ship cascade v0.
