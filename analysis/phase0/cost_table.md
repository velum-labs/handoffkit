# Phase 0 per-domain calibration cost table

Scope: estimate billed model cost for C3/M5 calibration over the taxonomy domains. This is a planning estimate, not a provider invoice.

## Price assumptions

Repository pricing source: `spec/registry/pricing.json` says prices are approximate USD per 1M tokens and are generated into the registry. (`spec/registry/pricing.json:2`)

| Model | Assumed input $/1M | Assumed output $/1M | Evidence |
| --- | ---: | ---: | --- |
| `gpt-5.5` | $1.25 | $10.00 | `spec/registry/pricing.json:41` |
| `claude-sonnet-4-6` | $3.00 | $15.00 | `spec/registry/pricing.json:17` |
| `gemini-2.5-pro` | $1.25 | $10.00 | `spec/registry/pricing.json:25` |

Default deployable panel assumption: `gpt-5.5`, `claude-sonnet-4-6`, and `gemini-2.5-pro`, matching the generated default cloud panel. (`packages/registry/src/generated/data.ts:192`)

Panel-of-3+judge formula:

- generators: one run each on `gpt-5.5`, `claude-sonnet-4-6`, `gemini-2.5-pro`;
- judge/synth pass: one `gpt-5.5` pass over anonymized candidates;
- single-shot judge overhead estimate: input `0.6 * task_input + 3 * candidate_output + 1k`, output `0.8k`;
- agentic judge overhead estimate: input `0.35 * cumulative_input + 3 * candidate_output + 10k` logs/context, output `2k`;
- costs exclude harness compute, external runner fees, retries, and storage unless stated.

## Token assumptions

| Domain | Single-shot tokens in/out | Agentic tokens in/out | Default route for panel estimate | Rationale |
| --- | ---: | ---: | --- | --- |
| `repo_bugfix` | 8k / 2k | 50-300k / 5-20k | agentic | Real repo work requires read/edit/test loops; C3 cannot use official SWE-bench in-repo today. |
| `algorithmic` | 2-5k / 1-3k | 10-40k / 2-8k | single-shot | LiveCodeBench-style prompt+tests is runnable and usually one generation plus grading. |
| `frontend_ui` | 4-10k / 2-5k | 50-180k / 5-15k | agentic | Real UI validation needs files, browser logs/screenshots, and iteration; harness missing today. |
| `backend_api_db` | 8-30k / 2-8k | 40-180k / 5-15k | agentic | API/DB tasks need service/test/migration loops when built. |
| `data_sql` | 4-15k / 1-4k | 15-80k / 2-8k | single-shot | Many SQL/pandas tasks are prompt+fixture+answer; harness missing today. |
| `devops_terminal` | 6-15k / 1-5k | 40-200k / 3-15k | agentic | Terminal-Bench-like work is command-loop heavy. |
| `refactor_migration` | 8-30k / 2-8k | 60-250k / 5-18k | agentic | Multi-file behavior-preserving changes need repo context and tests. |
| `security` | 6-25k / 2-6k | 50-200k / 5-15k | agentic | Secure implementation/exploit checks need iterative tests or analysis; harness missing today. |

## Per-task cost table

Midpoint costs; `gpt-5.5` and `gemini-2.5-pro` are identical under the current registry prices.

| Domain | Single-shot cost/task: GPT/Gemini | Single-shot cost/task: Sonnet | Agentic cost/task: GPT/Gemini | Agentic cost/task: Sonnet | Panel-of-3+judge cost/task, low/mid/high |
| --- | ---: | ---: | ---: | ---: | ---: |
| `repo_bugfix` | $0.030 | $0.054 | $0.308 | $0.630 | $0.523 / $1.388 / $2.590 |
| `algorithmic` | $0.024 | $0.041 | $0.081 | $0.150 | $0.060 / $0.109 / $0.157 |
| `frontend_ui` | $0.044 | $0.074 | $0.225 | $0.450 | $0.523 / $1.014 / $1.677 |
| `backend_api_db` | $0.055 | $0.096 | $0.225 | $0.450 | $0.464 / $1.014 / $1.677 |
| `data_sql` | $0.029 | $0.051 | $0.100 | $0.195 | $0.073 / $0.131 / $0.258 |
| `devops_terminal` | $0.030 | $0.054 | $0.205 | $0.420 | $0.386 / $0.936 / $1.799 |
| `refactor_migration` | $0.055 | $0.096 | $0.275 | $0.570 | $0.583 / $1.251 / $2.205 |
| `security` | $0.053 | $0.090 | $0.238 | $0.480 | $0.523 / $1.073 / $1.799 |

Sanity check: the committed Aider baseline table cites `gpt-5.5` at $29.08 for a 225-task run, or about $0.129/task, which sits near the single-shot/polyglot panel estimates after accounting for harness differences and attempts. (`python/fusionkit-evals/src/fusionkit_evals/public_bench.py:159`)

## Mixed-domain rollups

Assumed 100-task C3 mix: 20% `repo_bugfix`, 20% `algorithmic`, 10% `frontend_ui`, 15% `backend_api_db`, 10% `data_sql`, 10% `devops_terminal`, 10% `refactor_migration`, 5% `security`. This is deliberately more repo/backend-heavy than current harness support; if C3 is restricted to runnable-today tasks, the actual spend will be lower but less representative.

| Scenario | Avg panel-of-3+judge cost/task | C3 pilot: 100 tasks | Full calibration: 300 tasks x 4 runs |
| --- | ---: | ---: | ---: |
| Low | $0.369 | $36.89 | $110.68 |
| Mid | $0.838 | $83.82 | $251.47 |
| High | $1.487 | $148.72 | $446.15 |

Repeat/retry buffer:

- §15.2 requires 5-10% duplicate runs for variance estimation. (`docs/fusion/capability-index-spec.md:1347`)
- Add 15-30% for provider retries, failed tasks, and adapter reruns while C3 is still being debugged.
- Buffered C3 estimate: low/mid/high about **$50 / $115 / $210**.
- Buffered 300-task round estimate: low/mid/high about **$150 / $350 / $625**.

## Recommended C3 budget cap

Set the C3 hard cap at **$250 model spend** for a 100-task mixed pilot. This covers the high token scenario plus duplicate/retry buffer while still failing fast if agentic repo/frontend/terminal tasks run much longer than expected.

If C3 is narrowed to algorithmic + data tasks only, use a lower cap of **$75**. If C3 is deliberately repo/terminal-heavy, use **$400** and require per-task cost logging from the first 10 tasks before completing the run.

## Caveats

- The harness inventory shows several domains are not runnable today, so their costs are what a future adapter/harness would likely cost, not what this repo can currently execute.
- Judge/synth token costs are estimated because some report paths only surface solver candidate cost; the public benchmark docs call this out as a current limitation. (`docs/public-benchmark-comparison.md:112`)
- Official benchmark adapters may add non-token costs: container time, paid benchmark infrastructure, dataset access, failed checkouts, and wall-clock concurrency limits.
