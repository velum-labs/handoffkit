---
id: e004-truncation-fair-rescreen
owner: alen
status: analyzed
benchmark: livecodebench
claim: "truncation-fair open floor and complementarity for the seven capped models"
sweep_id: e004-truncation-fair-rescreen
budget_usd: 45
spent_usd: 43.93
created: 2026-07-15
updated: 2026-07-15
---

## Hypothesis
With 64k token budgets, at least one of the seven truncation-invalidated
models (r1, kimikt, kimi26, glm52, nemotron3s, dsv4pro, qwen3t) lands far
above its capped e002 rate, and the corrected complementarity matrix yields a
panel partner with real union headroom (>=5pp) over solo qwen3.7-max.

## Design
Seven solo cells on the full 110-task dev manifest (same hash as e002 for
instance pairing) with max_tokens=65536, attempts=2, request_timeout_s=1500
(fits the 3600 s Batch wall clock). Requires PR #113 merged first: adapter v2
(fair 30 s grading wall, version bump) and a rebuilt runner image. Estimated
~$25 at observed token medians, worst case ~$40. Baselines are never
re-billed: anchors and the four untruncated solos come from the e002 store,
re-graded locally at the v2 wall clock (zero spend) for like-for-like pairing.
The six special-judge dev instances run but are excluded from analysis.
2026-07-15 scope trim: qwen3t cell cancelled before start — mid-run projection
hit the $45 ceiling; qwen3t was the least truncation-damaged of the seven.

## Out of scope
Anchor re-runs, the four untruncated e002 solos, fused cells, prompt tuning,
kernel probes (a new proposal after this measures real headroom), and the
locked holdout.

## Decision rule
Compute the corrected floor and the q37max-paired union coverage on shared
non-special-judge instances. If some model or pair shows >=5pp union headroom
over solo q37max (n>=60), propose kernel probes on that panel; if the
corrected floor still saturates within 2pp with no headroom, the compound
search on this slice is dead — propose the holdout parity final instead.

## Results
Complete-case, special-judge-excluded floors were dsv4pro 62.5% [52.9%,
71.2%], kimi26 60.4%, r1 52.7%, kimikt 40.2%, glm52 39.8%, and nemotron3s
25.7%. Spend was $43.93 of $45; qwen3t was cancelled before generation.
Audit errata (2026-07-15): provider/infrastructure errors were omitted from
denominators. R1 is 39/104=37.5% under errors-as-failures, not 39/74=52.7%.
GLM/Kimi-thinking still truncated 26-40% at 64k. The reported +0.0–1.4pp
q37 union gains had no uncertainty interval; one unique solve in 74 has a
Wilson upper bound above the 5pp futility threshold. The corrected q37 v2
pass vector was not persisted, so exact paired recomputation is unavailable.
This screen supports weak observed complementarity for six attempted models,
but not a population-level no-headroom result or formal q37/anchor parity.

## Decision
Withdraw “compound search is dead.” Missingness, residual truncation,
qwen3t cancellation, and omitted union uncertainty prevent the futility gate
from firing. Pause the e005 reserve spend; run a correctness-gated recovery
canary on an unsaturated dev slice before any locked-holdout evaluation.

## Follow-ups
- claimed: alen — correctness-gated recovery canary; e005 remains unspent
- up-for-grabs — qwen3t reasoning-aware screen on a fresh dev slice
- up-for-grabs — model-specific reasoning/final-answer budgets
