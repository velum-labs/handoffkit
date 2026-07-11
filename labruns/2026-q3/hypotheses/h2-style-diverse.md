---
hypothesis_id: h2-style-diverse
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
  - endpoint_id: glm52
    slug: z-ai/glm-5.2
    provider: openrouter
    identity_hash: 7cc232aa3fca6f21
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
  per_request_usd: 0.06538
  sweep_60_tasks_usd: 3.92251
prediction: "Beats H1 by at least 2 pp by trading one DeepSeek-heavy member for a GLM-5 reasoning style."
kill_condition: "H2 <= H1 on the calibration bank; stop near-tie diversity swaps."
expiry: 2026-11-07
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-2026-07-07.md
  rules_version: ensemble-launch-clean-room-2026-07.md
---

# H2 Style-Diverse

This hypothesis starts from H1 and makes one allowed near-tie swap:
`deepseek/deepseek-v4-pro` (rank 3, aggregate `68.32`) is replaced by
`z-ai/glm-5.2` (rank 5, aggregate `65.43`), a `2.89 pp` difference inside the
plan's ~2-3 pp public leaderboard noise band. The resulting panel keeps a
code-strong DeepSeek member, a fast cheap Nemotron generalist, and a GLM-5
reasoning/instruction family.

Vetoes applied: lineages are `deepseek-v3`, `nemotron-3-super`, and `glm-5`;
all members have explicit 32k caps with 64k escalation entries in the registry;
providers are pinned in the snapshot to StreamLake, DeepInfra, and Novita;
panel-member cost is `$0.03163`, below the `$0.08333` one-third GPT-5.5 anchor
envelope.

Judge choice: the common `qwen/qwen3.7-max` judge is pinned to Alibaba and is
not a panel member, preserving comparability with H1 and H5.

Cost math: panel members use `2k input + 8k output` each:
`ds32 $0.0032032 + nemotron3s $0.0037600 + glm52 $0.0246620 =
$0.0316252`. The judge costs `$0.0337500`, so the total per request is
`$0.0653752`; 60 tasks cost `$3.922512`.

Falsification: if H2 does not beat H1, the near-tie style swap is not useful
enough to keep. Shippable verdict if H2 wins: carry the GLM diversity bet into
Phase C. Shippable verdict if it loses: keep H1 and stop spending on this swap.
