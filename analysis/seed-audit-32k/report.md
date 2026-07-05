# D10 seed-panel truncation audit report

## Verification

- r1: 60 rows and exact manifest order.
- terminus: 60 rows and exact manifest order.
- qwen3t: 60 rows and exact manifest order.
- Ledger summed spend: $5.00 (cap $20.00).
- Metrics recomputed directly from the outcome CSVs, not script stdout.

## Per-model results

| Model | Budget | pass@1 (context) | Wilson 95% CI | truncated | mean completion tokens | provider failures | spend |
|---|---:|---:|---:|---:|---:|---:|---:|
| deepseek-r1-0528 | 32k | 24/60 (40.0%) | [28.6%, 52.6%] | 15/50 | 20119 | 10 | $2.61 |
| deepseek-v3.1-terminus | 32k | 23/60 (38.3%) | [27.1%, 51.0%] | 0/60 | 2240 | 0 | $0.14 |
| qwen3-235b-a22b-thinking-2507 | 32k | 30/60 (50.0%) | [37.7%, 62.3%] | 19/57 | 25086 | 3 | $2.26 |

## Verdicts (binding for the D10 seed panel)

- **deepseek-r1-0528: ESCALATION PENDING.** deepseek-r1-0528 exceeds the truncation threshold at 32k (15/50); the preregistered 64k escalation has not produced outcomes yet.
- **deepseek-v3.1-terminus: VALID at 32k.** deepseek-v3.1-terminus is validly measurable at a 32k completion budget (0/60 truncated).
- **qwen3-235b-a22b-thinking-2507: ESCALATION PENDING.** qwen3-235b-a22b-thinking-2507 exceeds the truncation threshold at 32k (19/57); the preregistered 64k escalation has not produced outcomes yet.

## Spend

- Total ledger spend: $5.00.
- qwen3t: $2.26
- r1: $2.61
- terminus: $0.14

## Limitations

- Algorithmic 60-task slice; truncation behavior on repo-bugfix prompts may differ (longer prompts, but patch outputs are usually shorter than full programs). Revisit after Step 4 unlocks repo grading.
- Pass rates are context only; this round measures validity, not domain skill.

## Deviations and holds (2026-07-05)

- The preregistered 64k escalation for r1 and qwen3t, and the targeted reruns
  of provider-failed rows, are **held** by the strategy rethink
  (`docs/fusion/strategy-rethink-2026-07.md`): the D10 seed panel members are
  two to three generations behind the current OSS frontier, so further spend
  on this panel is paused pending the refreshed shortlist.
- The hold does not change the 32k verdicts. Both r1 (15 truncated) and
  qwen3t (19 truncated) exceed the 6-row threshold even if every failed row
  were rerun successfully without truncation, so their 32k pass rates are
  INVALID regardless; terminus is VALID at 32k with a full 60/60 clean rows.
- r1's 10 provider failures and qwen3t's 3 are mid-stream JSON parse errors
  from OpenRouter ("Expecting value: line N column 1"), i.e. malformed
  streaming chunks — a client-robustness item for the harness backlog, not a
  model capability signal.
