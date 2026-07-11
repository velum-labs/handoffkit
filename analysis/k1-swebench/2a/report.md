# Round 2A' report: frozen-winner confirmation on the fresh slice

Preregistration: `preregistration.md` (frozen; no deviations). All numbers
recomputed from official harness report JSONs. Fused config:
v2-strict-commit, byte-frozen from round 2C.

## Results (n=30, fresh, repo-stratified, disjoint from dev)

| row | resolved | rate | Wilson 95% |
|---|---|---|---|
| solo-terminus | 20/30 | 66.7% | [48.8%, 80.8%] |
| solo-qwen3 | 12/30 | 40.0% | [24.6%, 57.7%] |
| **fused (N=2, k=1, v2)** | **18/30** | **60.0%** | [42.3%, 75.4%] |
| oracle(solo) | 21/30 | 70.0% | [52.1%, 83.3%] |

Pre-registered read-outs:

- **Fused vs best solo: −2.** The fused solve set is a *strict subset* of
  terminus's: it lost `django__django-13837` and `sympy__sympy-14248` and
  gained nothing.
- **Fused-only-solve rate: 0/9.** Nine instances were solved by neither
  member; fused solved none of them. The round-1 `django-12125`
  observation does not generalize at this configuration (upper 95% bound
  on the rate ≈ 30%, point estimate 0).
- **Best-member-loss rate: 2/20 (10%).** Consistent with round 1 (2/6...
  round-1 losses were 2 of terminus's 6 solves) and the dev reruns.
- **Selection headroom: +1** (qwen3's one unique solve, `django-14500`,
  which fused failed to capture). qwen3 also produced 7/30 empty patches —
  dead weight confirmed at n=30.
- Process metrics at n=30 (1417 steps): judge null rate 57.9%, verbatim
  compliance on contested steps 29.1% — the 2C dev-scale numbers
  reproduce on fresh data.

## Conclusion (this configuration)

**Route, don't fuse.** With this panel (terminus + qwen3), this judge
(terminus), and the current k=1 aggregation pipeline, fusion is a strict
tax on the best member: ~10% of best-member solves lost per run, nothing
gained, ~3x per-step latency, ~3-4x cost. The launch-plan's own framing
applies: "route, don't fuse" is a legitimate, publishable verdict — and it
is the verdict here.

What this does NOT conclude:

- Nothing about better panels: qwen3 contributed almost nothing
  (1 unique solve, 7 empty patches); a complementary second member is
  untested, and selection headroom was near zero throughout. Panel
  composition is the next experiment if fusion on repo-bugfix is pursued.
- Nothing about engine-level fixes: 2C showed the judge-abstention and
  verbatim-compliance problems are prompt-resistant; the mechanical fix
  (engine emits the picked candidate's batch directly, like the no-tools
  `select_best` path) is a source change this branch's config-only rule
  excluded — it is the highest-leverage product change this program has
  identified.

## Spend

Solos $0.36 + $1.09; fused ≈ $4-6 by call volume (3037 calls). Round
total ≈ $6-8 of the $40 cap. Program total across rounds ≈ $12-16.
