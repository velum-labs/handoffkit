# Non-linear pilot report: width-vs-repair at matched budget

Preregistration: `preregistration.md` (frozen read-out rules; one recorded
loader deviation, noted there before the billed run). Raw rows: `rows.jsonl`;
summary: `results.json`. Panel: deepseek-v3.1-terminus + qwen3-coder
(OpenRouter). Slice: 30 newest release_v6 stdin tasks; 25 scored, 5 dropped
symmetrically on persistent provider decode errors (all terminus-side,
recorded in `results.json`).

## Results (n=25)

| arm | passed | rate | Wilson 95% |
|---|---:|---:|---|
| solo-terminus | 10/25 | 40.0% | [23.4%, 59.3%] |
| solo-qwen3 | 7/25 | 28.0% | [14.3%, 47.6%] |
| linear-6wide (exec-select) | 12/25 | 48.0% | [30.0%, 66.5%] |
| nonlinear-4+2 (exec-select + repair) | 12/25 | 48.0% | [30.0%, 66.5%] |
| oracle-6wide | 14/25 | 56.0% | [37.1%, 73.3%] |

- nonlinear vs linear (paired): 1 win, 1 loss, McNemar p = 1.0 — a tie.
- nonlinear vs solo-terminus: +2/−0 (p = 0.5); linear vs solo-terminus is the
  same +2/−0. Execution-guided selection over the pool again beats the best
  solo member (consistent with the c3/LCB record), though not significantly
  at this n.
- Cost per task set: nonlinear $0.368 vs linear $0.529 (0.69x), with 68% of
  tasks early-exiting after the 4 narrow samples.

## Verdict per the pre-registered rules: KILL (this configuration)

- **Repair conversion 2/16 = 12.5% < 15% kill threshold.** Feeding one
  failing public test back to terminus converted few failures.
- Overfit check: repaired public-passers went 1/2 on private vs 70.6% for
  sampled public-passers — directionally worse than the 15pp allowance, but
  the denominator (2) is too small to weigh.
- Point estimate is a tie, not a win.

The 4+2 execution-feedback repair loop, as configured (terminus as repairer,
single failing-test feedback, top-2 targets), does not earn a Phase A lane.

## What the rows actually show (hypotheses for the next pilot, not claims)

1. **Repair can compose solves that pure sampling cannot.** On `abc398_f` the
   repaired candidate passed private while ALL SIX sampled candidates failed
   (pool oracle = F). This is the single-shot analog of the k1 "driver-only
   solve": the loop created a novel win selection could never reach. Rare
   (1/25) but real.
2. **The cost saving came from adaptive width, not repair.** The non-linear
   arm matched the linear arm at 0.69x cost because 68% of tasks stopped at 4
   samples once a public-passer existed. "Sample-until-public-pass" (a
   conditional cascade, no repair at all) is the cheapest member of this
   family and should be a Phase A row: expected ~equal quality to 6-wide at
   ~0.6-0.7x cost.
3. **The lost discordant task was public-test overfit** (`abc397_e`: repair
   passed 2/2 public, failed private; linear's extra temp-0.9 sample found a
   true solve). This is precisely the failure mode adversarial test synthesis
   (campaign §2b item 3) targets — the two architectures are complements, not
   alternatives.
4. Both repair conversions were terminus repairing its own samples; the
   cross-model arm (terminus repairing qwen3) never converted. No evidence
   for cross-model repair here.

## Spend

Billed ≈ $0.90 total (6-wide samples $0.53 + repairs ~$0.09 + calls on the 5
dropped tasks), well under the $5 cap.

## Next actions folded into the campaign plan

- Phase A gains a free-ish "adaptive-width cascade" row (observation 2).
- The repair family may be re-piloted only with a changed configuration,
  written down first: richer feedback (all failing tests + diffs), a
  lineage-external repairer (e.g. gpt-5-mini class), or repair gated on
  near-miss public scores (candidates passing >50% of public tests).
