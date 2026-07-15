---
id: e004-truncation-fair-rescreen
owner: alen
status: proposed
benchmark: livecodebench
claim: "truncation-fair open floor and complementarity for the seven capped models"
sweep_id: e004-truncation-fair-rescreen
budget_usd: 45
spent_usd: 0
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

## Decision

## Follow-ups
