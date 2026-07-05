# Thinking-model 32k measurement report

## Verification

- kimi: 60 rows and exact manifest order.
- sonnet: 60 rows and exact manifest order.
- Ledger rows: 132; summed spend: $9.07.
- Metrics below were recomputed directly from `outcomes_32k.csv` and `c3r16k_outcomes.csv`.

## Per-model results

| Model | Budget | pass@1 | Wilson 95% CI | truncated | mean completion tokens | provider failures | spend |
|---|---:|---:|---:|---:|---:|---:|---:|
| kimi | 16k | 7/60 (11.7%) | [5.8%, 22.2%] | 52/60 | 15278 | 0 | $2.31 |
| kimi | 32k | 13/60 (21.7%) | [13.1%, 33.6%] | 42/60 | 27331 | 0 | $4.12 |
| sonnet | 16k | 25/60 (41.7%) | [30.1%, 54.3%] | 14/60 | 5537 | 0 | $5.10 |
| sonnet | 32k | 27/60 (45.0%) | [33.1%, 57.5%] | 0/60 | 3435 | 1 | $3.33 |

## OSS-relevant panel context

| Model | Source | pass@1 | Wilson 95% CI | truncated |
|---|---|---:|---:|---:|
| deepseek | 16k | 13/60 (21.7%) | [13.1%, 33.6%] | 6/60 |
| qwen3 | 16k | 18/60 (30.0%) | [19.9%, 42.5%] | 0/60 |
| kimi | 32k | 13/60 (21.7%) | [13.1%, 33.6%] | 42/60 |
| sonnet | 32k | 27/60 (45.0%) | [33.1%, 57.5%] | 0/60 |
| gpt55 | 16k | 48/60 (80.0%) | [68.2%, 88.2%] | 1/60 |

gpt-5.5 remains lopsided on this slice: 80.0% vs the best OSS/open alternative at 45.0%.

## Truncation-rule compliance

- kimi: 42/60 rows truncated at 32k, so the pass rate is INVALID under the <=10% rule.
- sonnet: 0/60 rows truncated at 32k, so the pass rate is VALID under the <=10% rule.

Kimi did not trigger the preregistered 64k escalation because it stayed within the truncation threshold at 32k.

## Spend

- Total ledger spend: $9.07.
- Includes a $1.63 adjustment for the stopped first attempt, based on completed task costs printed before that process was stopped.
- Kimi ledger spend: $4.12.
- Sonnet ledger spend: $3.33.

## Limitations and anomalies

- sonnet on arc192_e did not return a completion and is counted as a fail: hard task timeout after 10800s
- The run remains a single 60-task algorithmic slice from the C3-R16K bank.
- Targeted reruns replaced only failed rows; successful first-pass rows were kept.
