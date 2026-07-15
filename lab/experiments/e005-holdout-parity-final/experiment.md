---
id: e005-holdout-parity-final
owner: alen
status: proposed
benchmark: livecodebench
claim: "locked-holdout parity final: qwen3.7-max vs both anchors, once"
sweep_id: e005-holdout-parity-final
budget_usd: 60
spent_usd: 0
created: 2026-07-15
updated: 2026-07-15
---

## Hypothesis
Solo qwen3.7-max holds GPT-5.5 parity (McNemar non-significant, anchor rate
inside its Wilson interval — ladder rung 2) on the never-touched holdout,
making the campaign claim: an open-weight solo matches the closed frontier on
this benchmark at ~1/10th the cost, and no open compound adds headroom.

## Design
Three solo cells, run once, on the 64 holdout tasks that survive the
special-judge exclusions (70 minus 6): qwen3.7-max, GPT-5.5, Opus 4.8, all
via OpenRouter with max_tokens=65536, attempts=2, request_timeout_s=1500,
adapter v2, runner revision 9. 192 shards, estimated ~$25 (anchor output
pricing dominates), ceiling $60 (the reserve). This is the campaign final:
no retries beyond the harness caps, no tuning, no second look.

## Out of scope
Fused cells (e003/e004 killed compound search on this slice), dev-split
reruns, any model beyond the three finalists, prompt or config changes,
and any further holdout evaluation after this one.

## Decision rule
Written before running: report rung 2 parity if the GPT-5.5 rate falls inside
qwen3.7-max's Wilson 95% interval AND paired McNemar is non-significant
(p>=0.05); report the gap with CIs otherwise. Carry the contamination caveat
verbatim from STARTING_POINT.md. Either outcome concludes the campaign.

## Results

## Decision

## Follow-ups
