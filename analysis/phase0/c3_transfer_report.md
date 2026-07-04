# Phase 0 C3 transfer pilot report

- Verdict: **PASS**
- Total API spend tracked: $6.4062
- Workload: single-shot LiveCodeBench-style algorithmic tasks; deterministic stdin/stdout grading.
- Task window: `release_v6`, 60 tasks, contest dates 2025-02-08 through 2025-04-06 across 14 contest-date clusters. The preferred post-2025-06 window had zero qualifying stdin/no-starter tasks, so the preregistered 2025-01 fallback was used.
- Model-id smokes: `claude-sonnet-4-6`, `moonshotai/kimi-k2-thinking`, `deepseek/deepseek-chat`, and `qwen/qwen3-coder` all resolved; no model-id fallback was needed.
- Spend note: OpenAI/Anthropic costs came from configured token pricing; OpenRouter provider-cost lookups were unavailable, so OpenRouter spend uses published list-price token estimates from captured prompt/completion counts. The total includes a conservative $0.25 estimate for a failed optional Kimi capture replay attempt.

## Per-model pass rates

| Model | n | pass@1 | Wilson 95% CI | provider failures |
| --- | ---: | ---: | ---: | ---: |
| `deepseek` (deepseek/deepseek-chat) | 59 | 27.1% | [17.4%, 39.6%] | 1 |
| `gpt55` (gpt-5.5) | 60 | 48.3% | [36.2%, 60.7%] | 0 |
| `kimi` (moonshotai/kimi-k2-thinking) | 58 | 5.2% | [1.8%, 14.1%] | 2 |
| `qwen3` (qwen/qwen3-coder) | 60 | 26.7% | [17.1%, 39.0%] | 0 |
| `sonnet` (claude-sonnet-4-6) | 60 | 38.3% | [27.1%, 51.0%] | 0 |

## Pre-named panel oracle/headroom

| Panel | Members | n | best single | oracle | headroom | bootstrap 95% CI |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| P1_public_complementarity | qwen3, deepseek, kimi | 57 | 28.1% | 35.1% | 7.0% | [1.7%, 10.5%] |
| P2_top_public_average | gpt55, sonnet, deepseek | 59 | 49.2% | 54.2% | 5.1% | [0.0%, 12.5%] |
| P3_product_default_restricted | kimi, qwen3, deepseek | 57 | 28.1% | 35.1% | 7.0% | [1.7%, 10.5%] |

## Public vs calibrated failure-dependence signs

Agreement: 10 / 10

| Pair | public phi/sign | calibrated phi/sign | agreement | mapping note |
| --- | ---: | ---: | --- | --- |
| deepseek / gpt55 | 0.391 / positive | 0.620 / positive | yes | public deepseek-v3.1-terminus vs calibrated deepseek-chat; public gpt-5 vs calibrated gpt-5.5 |
| deepseek / kimi | 0.660 / positive | 0.394 / positive | yes | public deepseek-v3.1-terminus vs calibrated deepseek-chat; public kimi-k2-0905 vs calibrated kimi-k2-thinking |
| deepseek / qwen3 | 0.594 / positive | 0.571 / positive | yes | public deepseek-v3.1-terminus vs calibrated deepseek-chat; public Qwen3-8B vs calibrated qwen3-coder |
| deepseek / sonnet | 0.600 / positive | 0.607 / positive | yes | public deepseek-v3.1-terminus vs calibrated deepseek-chat; public claude-sonnet-4 vs calibrated claude-sonnet-4-6 |
| gpt55 / kimi | 0.403 / positive | 0.250 / positive | yes | public gpt-5 vs calibrated gpt-5.5; public kimi-k2-0905 vs calibrated kimi-k2-thinking |
| gpt55 / qwen3 | 0.431 / positive | 0.548 / positive | yes | public gpt-5 vs calibrated gpt-5.5; public Qwen3-8B vs calibrated qwen3-coder |
| gpt55 / sonnet | 0.388 / positive | 0.609 / positive | yes | public gpt-5 vs calibrated gpt-5.5; public claude-sonnet-4 vs calibrated claude-sonnet-4-6 |
| kimi / qwen3 | 0.594 / positive | 0.378 / positive | yes | public kimi-k2-0905 vs calibrated kimi-k2-thinking; public Qwen3-8B vs calibrated qwen3-coder |
| kimi / sonnet | 0.583 / positive | 0.299 / positive | yes | public kimi-k2-0905 vs calibrated kimi-k2-thinking; public claude-sonnet-4 vs calibrated claude-sonnet-4-6 |
| qwen3 / sonnet | 0.555 / positive | 0.532 / positive | yes | public Qwen3-8B vs calibrated qwen3-coder; public claude-sonnet-4 vs calibrated claude-sonnet-4-6 |

## Capture

- Mode: judge_select_best_replay
- Judge: `gpt55`
- n: 57
- fused pass rate: 38.6%
- best single: 28.1%
- oracle: 35.1%
- capture: 150.0%
- Note: raw capture is above 100% because GPT-5.5 fallback replay sometimes synthesized/verbatim-selected answers that passed despite the frozen P1 bank marking no P1 candidate as passing on those tasks. Treat this as measured fused uplift on the replay path, not a pure judge-only headroom-capture estimate.

## Verdict rules

- Headroom >= 5 pp in a pre-named K=3 panel: PASS
- Public/calibrated dependence sign agreement: PASS

## Limitations and fallbacks

- Single-shot code generation only; no agentic/multi-turn workloads were run.
- Algorithmic-only domain because the in-repo harness inventory showed that this is the runnable deterministic path today.
- Public model mappings include version/family mismatches; each pair is labeled in the sign table.
- P1 and P3 are identical because the committed default contributes Kimi + Qwen3 and DeepSeek is the pre-registered third member.
- Provider failures were excluded from denominators and common-task panel metrics: DeepSeek had 1 generation failure and Kimi had 2 generation failures.
- Optional capture first attempted the committed Kimi judge, but OpenRouter returned a malformed JSON response after 14 cached task results; the report therefore uses the preregistered GPT-5.5 fallback judge.
