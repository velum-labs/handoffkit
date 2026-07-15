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
Corrected floor (special-judge excluded, v2 grading): dsv4pro 62.5%
[52.9%, 71.2%], kimi26 60.4%, r1 52.7% (74 graded; 32 wall-clock timeouts),
kimikt 40.2%, glm52 39.8%, nemotron3s 25.7%. Truncation had understated
dsv4pro by ~25pp, kimi26 by ~35pp, r1 by ~33pp — but every model remains
significantly below solo qwen3.7-max 76.0% (all McNemar p<=0.003). Union
headroom over q37max: +0.0 to +1.4pp, far under the preregistered 5pp bar.
q37max-vs-GPT-5.5 parity on the cleaned slice: 0/1 discordants, p=1.0
(n=53). glm52/kimikt still truncate 26-40% even at 64k. Spend $43.93 of $45
(qwen3t trimmed at the ceiling).

## Decision
The corrected complementarity gate fails everywhere: no model or pair offers
>=5pp union headroom over solo qwen3.7-max, so compound search on this slice
is dead per the preregistered rule. The campaign's remaining claim is the
parity result; take it to the locked holdout as the final (from the reserve).

## Follow-ups
- claimed: alen — e005 holdout final: solo q37max vs both anchors, once, from
  the $60 reserve, exclusions applied
- up-for-grabs — qwen3t 64k re-screen (trimmed here) if anyone needs its floor
- up-for-grabs — reasoning-aware truncation handling for glm52/kimikt (>64k)
