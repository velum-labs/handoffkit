# Thinking-model 32k measurement report

## Verification

- kimi: 60 rows and exact manifest order.
- sonnet: 60 rows and exact manifest order.
- kimi 64k escalation: 60 rows and exact manifest order.
- Ledger rows: 197; summed spend: $16.51.
- Metrics below were recomputed directly from `outcomes_32k.csv`, `outcomes_64k_kimi.csv`, and `c3r16k_outcomes.csv`.

## Per-model results

| Model | Budget | pass@1 | Wilson 95% CI | truncated | mean completion tokens | provider failures | spend |
|---|---:|---:|---:|---:|---:|---:|---:|
| kimi | 16k | 7/60 (11.7%) | [5.8%, 22.2%] | 52/60 | 15278 | 0 | $2.31 |
| kimi | 32k | 13/60 (21.7%) | [13.1%, 33.6%] | 42/60 | 27331 | 0 | $4.12 |
| kimi | 64k | 17/60 (28.3%) | [18.5%, 40.8%] | 31/60 | 49439 | 0 | $7.44 |
| sonnet | 16k | 25/60 (41.7%) | [30.1%, 54.3%] | 14/60 | 5537 | 0 | $5.10 |
| sonnet | 32k | 27/60 (45.0%) | [33.1%, 57.5%] | 0/60 | 3435 | 1 | $3.20 |

## OSS-relevant panel context

| Model | Source | pass@1 | Wilson 95% CI | truncated |
|---|---|---:|---:|---:|
| deepseek | 16k | 13/60 (21.7%) | [13.1%, 33.6%] | 6/60 |
| qwen3 | 16k | 18/60 (30.0%) | [19.9%, 42.5%] | 0/60 |
| kimi | 64k | 17/60 (28.3%) | [18.5%, 40.8%] | 31/60 |
| sonnet | 32k | 27/60 (45.0%) | [33.1%, 57.5%] | 0/60 |
| gpt55 | 16k | 48/60 (80.0%) | [68.2%, 88.2%] | 1/60 |

gpt-5.5 remains lopsided on this slice: 80.0% vs the best valid OSS alternative at 30.0% (qwen3) and the best closed alternative at 45.0% (sonnet). Note kimi's numbers are truncation-invalid at every budget tried.

## Truncation-rule compliance

- kimi: 42/60 rows truncated at 32k, so the pass rate is INVALID under the <=10% rule.
- sonnet: 0/60 rows truncated at 32k, so the pass rate is VALID under the <=10% rule.

Kimi exceeded the truncation threshold at 32k, so the preregistered 64k escalation was run: 31/60 rows truncated at 64k, pass rate INVALID under the <=10% rule. Per the preregistration, kimi is reported as **not measurable at practical budgets** on this slice.

## Spend

- Total ledger spend: $16.51.
- Includes a $1.63 adjustment for the stopped first attempt, based on completed task costs printed before that process was stopped.
- Kimi ledger spend: $11.56.
- Sonnet ledger spend: $3.33.

## Limitations and anomalies

- sonnet on arc192_e did not return a completion and is counted as a fail: hard task timeout after 10800s
- The run remains a single 60-task algorithmic slice from the C3-R16K bank.
- Targeted reruns replaced only failed rows; successful first-pass rows were kept.
