# C0 deployable-model public coverage

Generated: 2026-07-04T07:54:28+00:00

## C0 verdict

PARTIAL: deployable frontier has meaningful A/A- per-task coverage, but it is uneven and largely source-dependent. Terminal-Bench and SWE-bench cover several current agentic/code frontier families; LLMRouterBench covers GPT-5/Claude-4/Gemini-2.5/Kimi/DeepSeek in a same-framework routing corpus; LiveBench/BigCodeBench lag the newest deployables. Proceed to C1/C2 on dense systems, but do not treat public priors as sufficient for final deployable panel selection without C3 calibration.

Recommended C1/C2 source: **Terminal-Bench first for deployable agentic coverage**, with **LLMRouterBench** as the clean same-framework method-validation fallback. SWE-bench is valuable but scaffold-confounded; use it to validate repo-bugfix complementarity across strong systems, not as raw model truth.

## Deployable coverage table

Cells are public per-task/per-instance outcome rows. SWE-bench and Terminal-Bench rows are A- because they are agent/scaffold-confounded. LLMRouterBench and BigCodeBench rows are code-subset/sample outcome rows. LiveBench cells show total rows with coding rows in parentheses.

| Base deployable engine | Providers | Deployable model IDs | Approx release / uncertainty | SWE-bench experiments | LLMRouterBench coding | LiveBench | BigCodeBench | Terminal-Bench |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-3.7-sonnet | anthropic | claude-3-7-sonnet-latest | 2025-02 approximate. | 7,494 (13 submissions; latest 20250625) | 0 | 1,154 (384 coding; latest 2025-04-01) | 592 (claude-3-7-sonnet-20250219--3200-output-128k-2025-02-19--main:bigcodebench-hard-complete; claude-3-7-sonnet-20250219--3200-output-128k-2025-02-19--main:bigcodebench-hard-instruct; claude-3-7-sonnet-20250219--main:bigcodebench-hard-complete; claude-3-7-sonnet-20250219--main:bigcodebench-hard-instruct) | 0 |
| anthropic/claude-haiku-4 family | anthropic | claude-haiku-4-5 | Haiku 4.5 catalog variant, approximate late-2025; uncertain. | 0 | 0 | 0 | 0 | 2,210 (5 systems; latest 2025-12-03) |
| anthropic/claude-opus-4 family | anthropic | claude-opus-4-8; claude-opus-4.8 | Claude Opus 4 began 2025-05; 4.5/4.8 catalog variants are late-2025/early-2026 uncertain. | 4,294 (5 submissions; latest 20251219) | 0 | 0 | 0 | 7,679 (19 systems; latest 2026-02-19) |
| anthropic/claude-sonnet-4 family | anthropic, claude, openrouter | anthropic/claude-sonnet-4.5; claude-sonnet-4-5; claude-sonnet-4-6 | Claude Sonnet 4 began 2025-05; 4.5/4.6 catalog variants are late-2025/early-2026 uncertain. | 13,194 (24 submissions; latest 20251103) | 1,555 (Claude-sonnet-4) | 0 | 0 | 2,652 (6 systems; latest 2025-12-21) |
| deepseek/deepseek-v3-chat | openrouter | deepseek/deepseek-chat | DeepSeek-V3/chat family, 2024-12/2025-03 approximate. | 1,600 (4 submissions; latest 20250609) | 3,110 (Deepseek-v3-0324; Deepseek-v3.1-terminus) | 1,280 (434 coding; latest 2025-04-01) | 7,432 (deepseek-ai--DeepSeek-V3-0324:bigcodebench-hard-complete; deepseek-ai--DeepSeek-V3-0324:bigcodebench-hard-instruct; deepseek-ai--DeepSeek-V3:bigcodebench-complete; deepseek-ai--DeepSeek-V3:bigcodebench-hard-complete; deepseek-ai--DeepSeek-V3:bigcodebench-hard-instruct; deepseek-ai--DeepSeek-V3:bigcodebench-instruct; new-deepseek-chat:bigcodebench-complete; new-deepseek-chat:bigcodebench-instruct) | 445 (1 systems; latest 2026-02-08) |
| google/gemini-2.0-flash | google | gemini-2.0-flash | 2024-12 preview / 2025-02 GA approximate. | 500 (1 submissions; latest 20250118) | 0 | 2,608 (768 coding; latest 2025-04-07) | 3,760 (gemini-2.0-flash-001--main:bigcodebench-hard-complete; gemini-2.0-flash-001--main:bigcodebench-hard-instruct; gemini-2.0-flash-exp--main:bigcodebench-complete; gemini-2.0-flash-exp--main:bigcodebench-hard-complete; gemini-2.0-flash-exp--main:bigcodebench-hard-instruct; gemini-2.0-flash-exp--main:bigcodebench-instruct; gemini-2.0-flash-lite-preview-02-05--main:bigcodebench-hard-complete; gemini-2.0-flash-lite-preview-02-05--main:bigcodebench-hard-instruct; gemini-2.0-flash-thinking-exp-01-21--main:bigcodebench-hard-complete; gemini-2.0-flash-thinking-exp-01-21--main:bigcodebench-hard-instruct) | 0 |
| google/gemini-2.5-flash | google | gemini-2.5-flash | 2025-04 approximate. | 300 (1 submissions; latest 20250528) | 1,555 (Gemini-2.5-flash) | 0 | 0 | 1,768 (4 systems; latest 2025-11-05) |
| google/gemini-2.5-pro | google, openrouter | gemini-2.5-pro; google/gemini-2.5-pro | 2025-03/2025-04 approximate. | 2,600 (6 submissions; latest 20250819) | 1,555 (Gemini-2.5-pro) | 418 (128 coding; latest 2025-04-01) | 296 (gemini-2.5-pro-exp-03-25--main:bigcodebench-hard-complete; gemini-2.5-pro-exp-03-25--main:bigcodebench-hard-instruct) | 1,768 (4 systems; latest 2025-11-05) |
| google/gemini-3-pro | google | gemini-3-pro | Catalog/benchmark frontier variant, approximate late-2025; uncertain. | 500 (1 submissions; latest 20251120) | 0 | 0 | 0 | 5,784 (13 systems; latest 2026-03-05) |
| meta/llama-3.3-70b-instruct | openrouter | meta-llama/llama-3.3-70b-instruct | 2024-12 approximate. | 1,000 (2 submissions; latest 20250516) | 0 | 418 (128 coding; latest 2025-02-06) | 2,280 (meta-llama--Llama-3.3-70B-Instruct:bigcodebench-complete; meta-llama--Llama-3.3-70B-Instruct:bigcodebench-instruct) | 0 |
| moonshot/kimi-k2 family | openrouter | moonshotai/kimi-k2; moonshotai/kimi-k2-thinking | Kimi K2 began 2025-07; thinking variant later, uncertain. | 1,500 (3 submissions; latest 20251014) | 1,555 (Kimi-k2-0905) | 0 | 0 | 3,125 (4 systems; latest 2026-01-28) |
| openai/gpt-4.1 family | openai | gpt-4.1; gpt-4.1-mini | 2025-04 approximate. | 7,988 (10 submissions; latest 20250915) | 0 | 294 (128 coding; latest 2025-02-06) | 0 | 0 |
| openai/gpt-5 family | codex, openai, openrouter | gpt-5; gpt-5.1; gpt-5.1-codex; gpt-5.3-codex; gpt-5.5; gpt-5.5-codex; openai/gpt-5.5 | GPT-5 public series began 2025-08; catalog also lists 5.1/5.3/5.5/Codex variants, latest dates uncertain/catalog-derived. | 5,294 (7 submissions; latest 20251103) | 3,110 (GPT-5-chat; GPT-5-medium) | 0 | 0 | 13,807 (32 systems; latest 2026-02-22) |
| openai/o4-mini | openai | o4-mini | 2025-04 approximate. | 3,200 (8 submissions; latest 20250625) | 0 | 0 | 0 | 0 |
| qwen/qwen3-coder family | openrouter | qwen/qwen3-coder | Qwen3-Coder 480B family, 2025-07 approximate. | 1,600 (4 submissions; latest 20250901) | 0 | 0 | 0 | 2,249 (3 systems; latest 2025-12-26) |
| qwen/qwen3-local-small | local | mlx-community/Qwen3-1.7B-4bit | Qwen3 small local model family, 2025-04 approximate. | 0 | 0 | 0 | 0 | 0 |
| xai/grok-4 | openrouter | x-ai/grok-4 | 2025-07 approximate. | 0 | 0 | 0 | 0 | 1,325 (3 systems; latest 2025-11-04) |

## Systems coverage table: dense non-deployable systems

These rows are useful for C1/C2 method validation even when they are not deployable endpoints in this product catalog.

| Source | System | Model key | Rows | Freshness | Notes |
| --- | --- | --- | --- | --- | --- |
| SWE-bench experiments | Sonar Foundation Agent + Claude 4.5 Opus | claude-opus-4-5 | 2,294 | 20251219 | test split; resolved=1207 |
| SWE-bench experiments | Salesforce AI Research SAGE (bash-only) | claude-sonnet-4.5; gpt-5 | 2,294 | 20251027 | test split; resolved=1015 |
| SWE-bench experiments | Atlassian Rovo Dev (2025-06-05) |  | 2,294 | 20250605 | test split; resolved=963 |
| SWE-bench experiments | Amazon Q Developer Agent (v20250405-dev) |  | 2,294 | 20250522 | test split; resolved=851 |
| SWE-bench experiments | SWE-agent 1.0 (Claude 3.7 Sonnet) | claude-3-7-sonnet-20250219 | 2,294 | 20250227 | test split; resolved=776 |
| SWE-bench experiments | Amazon Q Developer Agent (v20241202-dev) |  | 2,294 | 20250131 | test split; resolved=688 |
| SWE-bench experiments | OpenHands + CodeAct v2.1 (claude-3-5-sonnet-20241022) |  | 2,294 | 20241103 | test split; resolved=674 |
| SWE-bench experiments | AutoCodeRover-v2.0 (Claude-3.5-Sonnet-20241022) | claude-3-5-sonnet-20241022 | 2,294 | 20241121 | test split; resolved=571 |
| SWE-bench experiments | Honeycomb |  | 2,294 | 20240820 | test split; resolved=506 |
| SWE-bench experiments | Amazon Q Developer Agent (v20240719-dev) |  | 2,294 | 20240721 | test split; resolved=453 |
| SWE-bench experiments | Factory Code Droid |  | 2,294 | 20240617 | test split; resolved=442 |
| SWE-bench experiments | AutoCodeRover (v20240620) + GPT 4o (2024-05-13) | gpt-4o-2024-05-13 | 2,294 | 20240628 | test split; resolved=432 |
| LLMRouterBench | DeepHermes-3-Llama-3-8B-Preview | DeepHermes-3-Llama-3-8B-Preview | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | DeepSeek-R1-0528-Qwen3-8B | DeepSeek-R1-0528-Qwen3-8B | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | DeepSeek-R1-Distill-Qwen-7B | DeepSeek-R1-Distill-Qwen-7B | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | Fin-R1 | Fin-R1 | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | GLM-Z1-9B-0414 | GLM-Z1-9B-0414 | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | Intern-S1-mini | Intern-S1-mini | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | Llama-3.1-8B-Instruct | Llama-3.1-8B-Instruct | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LLMRouterBench | Llama-3.1-8B-UltraMedical | Llama-3.1-8B-UltraMedical | 2,193 | README Apr 2026 / HF bundle current at collection | HumanEval=164; MBPP=974; LiveCodeBench=1055 |
| LiveBench | command-r-plus-08-2024 | command-r-plus-08-2024 | 622 | 2025-04-03 | coding rows=256 |
| LiveBench | step-2-16k-202411 | step-2-16k-202411 | 621 | 2025-02-06 | coding rows=256 |
| LiveBench | Qwen2.5-7B-Instruct-Turbo | Qwen2.5-7B-Instruct-Turbo | 522 | 2024-12-10 | coding rows=256 |
| LiveBench | sonar | sonar | 521 | 2025-03-22 | coding rows=256 |
| LiveBench | Phi-3-mini-128k-instruct | Phi-3-mini-128k-instruct | 422 | 2024-12-10 | coding rows=256 |
| LiveBench | Phi-3-mini-4k-instruct | Phi-3-mini-4k-instruct | 422 | 2024-12-10 | coding rows=256 |
| LiveBench | Phi-3-small-128k-instruct | Phi-3-small-128k-instruct | 372 | 2024-12-10 | coding rows=206 |
| LiveBench | Phi-3-small-8k-instruct | Phi-3-small-8k-instruct | 372 | 2024-12-10 | coding rows=206 |
| BigCodeBench | 01-ai--Yi-1.5-34B-Chat | 01-ai--Yi-1.5-34B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-complete |
| BigCodeBench | 01-ai--Yi-1.5-34B-Chat | 01-ai--Yi-1.5-34B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-instruct |
| BigCodeBench | 01-ai--Yi-1.5-6B-Chat | 01-ai--Yi-1.5-6B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-complete |
| BigCodeBench | 01-ai--Yi-1.5-6B-Chat | 01-ai--Yi-1.5-6B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-instruct |
| BigCodeBench | 01-ai--Yi-1.5-9B-Chat | 01-ai--Yi-1.5-9B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-complete |
| BigCodeBench | 01-ai--Yi-1.5-9B-Chat | 01-ai--Yi-1.5-9B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-instruct |
| BigCodeBench | 01-ai--Yi-Coder-9B-Chat | 01-ai--Yi-Coder-9B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-complete |
| BigCodeBench | 01-ai--Yi-Coder-9B-Chat | 01-ai--Yi-Coder-9B-Chat | 2,280 | v0.2.5 published 2025-04-11 | bigcodebench-instruct |
| Terminal-Bench | terminus-2 | openai/gpt-oss-20b@together_ai | 932 | 2025-11-01 | agent/model trials |
| Terminal-Bench | terminus-2 | openai/gpt-oss-120b@together_ai | 925 | 2025-11-01 | agent/model trials |
| Terminal-Bench | terminus-2 | accounts/fireworks/models/glm-4p6@fireworks_ai | 904 | 2025-11-02 | agent/model trials |
| Terminal-Bench | terminus-2 | accounts/fireworks/models/minimax-m2@fireworks_ai | 902 | 2025-11-02 | agent/model trials |
| Terminal-Bench | mini-swe-agent | openai/gpt-oss-20b@together_ai | 888 | 2025-11-04 | agent/model trials |
| Terminal-Bench | mini-swe-agent | openai/gpt-oss-120b@together_ai | 887 | 2025-11-04 | agent/model trials |
| Terminal-Bench | claude-code | GLM-4.7@z-ai | 445 | 2026-02-07 | agent/model trials |
| Terminal-Bench | mini-swe-agent | grok-code-fast-1@xai | 445 | 2025-11-03 | agent/model trials |

## Deployable list extracted from repo

| Provider | Model | Base group | Repo source(s) |
| --- | --- | --- | --- |
| anthropic | claude-3-7-sonnet-latest | anthropic/claude-3.7-sonnet | modelCatalog.curated.anthropic |
| anthropic | claude-haiku-4-5 | anthropic/claude-haiku-4 family | modelCatalog.curated.claude-code; modelCatalog.curated.anthropic |
| anthropic | claude-opus-4-8 | anthropic/claude-opus-4 family | modelCatalog.curated.claude-code; modelCatalog.curated.anthropic; modelCatalog.benchmarkPanels.gpt-opus-smoke |
| anthropic | claude-opus-4.8 | anthropic/claude-opus-4 family | modelCatalog.benchmarkPanels.decorrelated-peers |
| anthropic | claude-sonnet-4-5 | anthropic/claude-sonnet-4 family | modelCatalog.defaultModelByAuthChoice.claude-code; modelCatalog.defaultModelByAuthChoice.anthropic; modelCatalog.curated.claude-code; modelCatalog.curated.anthropic |
| anthropic | claude-sonnet-4-6 | anthropic/claude-sonnet-4 family | modelCatalog.defaultCloudPanel; modelCatalog.curated.claude-code; modelCatalog.curated.anthropic; modelCatalog.benchmarkPanels.lopsided-default |
| claude | claude-sonnet-4-6 | anthropic/claude-sonnet-4 family | modelCatalog.smokeModels.claude |
| openrouter | anthropic/claude-sonnet-4.5 | anthropic/claude-sonnet-4 family | modelCatalog.defaultModelByAuthChoice.openrouter; modelCatalog.curated.openrouter |
| openrouter | deepseek/deepseek-chat | deepseek/deepseek-v3-chat | modelCatalog.curated.openrouter |
| google | gemini-2.0-flash | google/gemini-2.0-flash | modelCatalog.curated.google |
| google | gemini-2.5-flash | google/gemini-2.5-flash | modelCatalog.defaultModelByAuthChoice.google; modelCatalog.curated.google |
| google | gemini-2.5-pro | google/gemini-2.5-pro | modelCatalog.defaultCloudPanel; modelCatalog.curated.google |
| openrouter | google/gemini-2.5-pro | google/gemini-2.5-pro | modelCatalog.curated.openrouter |
| google | gemini-3-pro | google/gemini-3-pro | modelCatalog.benchmarkPanels.decorrelated-peers |
| openrouter | meta-llama/llama-3.3-70b-instruct | meta/llama-3.3-70b-instruct | modelCatalog.curated.openrouter |
| openrouter | moonshotai/kimi-k2 | moonshot/kimi-k2 family | modelCatalog.curated.openrouter |
| openrouter | moonshotai/kimi-k2-thinking | moonshot/kimi-k2 family | .fusionkit/fusion.json.panel; .fusionkit/fusion.json.judgeModel |
| openai | gpt-4.1 | openai/gpt-4.1 family | modelCatalog.curated.openai |
| openai | gpt-4.1-mini | openai/gpt-4.1 family | modelCatalog.curated.openai |
| codex | gpt-5.1-codex | openai/gpt-5 family | modelCatalog.curated.codex |
| codex | gpt-5.3-codex | openai/gpt-5 family | modelCatalog.curated.codex |
| codex | gpt-5.5 | openai/gpt-5 family | modelCatalog.defaultModelByAuthChoice.codex; modelCatalog.curated.codex |
| codex | gpt-5.5-codex | openai/gpt-5 family | modelCatalog.curated.codex; modelCatalog.smokeModels.codex |
| openai | gpt-5 | openai/gpt-5 family | modelCatalog.curated.openai |
| openai | gpt-5.1 | openai/gpt-5 family | modelCatalog.curated.openai |
| openai | gpt-5.5 | openai/gpt-5 family | modelCatalog.defaultCloudPanel; modelCatalog.defaultModelByAuthChoice.openai; modelCatalog.curated.openai; modelCatalog.benchmarkPanels.decorrelated-peers; modelCatalog.benchmarkPanels.lopsided-default; modelCatalog.benchmarkPanels.gpt-opus-smoke |
| openrouter | openai/gpt-5.5 | openai/gpt-5 family | modelCatalog.curated.openrouter |
| openai | o4-mini | openai/o4-mini | modelCatalog.curated.openai |
| openrouter | qwen/qwen3-coder | qwen/qwen3-coder family | modelCatalog.curated.openrouter; .fusionkit/fusion.json.panel |
| local | mlx-community/Qwen3-1.7B-4bit | qwen/qwen3-local-small | modelCatalog.defaultModelByAuthChoice.local |
| openrouter | x-ai/grok-4 | xai/grok-4 | modelCatalog.curated.openrouter |

## Source notes

- SWE-bench experiments: parsed 235 submission directories from `evaluation/{lite,verified,test}`; result files expose resolved IDs. Prediction files were not materialized by the sparse checkout, so `n_instances_reported` uses the split size fallback (lite=300, verified=500, test=2,294).
- LLMRouterBench: repo clone has no checked-in result JSON under `results/bench`; README points to a 1.28 GB HF `bench-release.tar.gz`. For C0 I used the README model pools and dataset-size tables without downloading the bundle. Coding coverage is 1,555 rows per flagship model (LiveCodeBench 1,055 + SWE-Bench 500) and 2,193 rows per lightweight model (HumanEval 164 + MBPP 974 + LiveCodeBench 1,055).
- LiveBench: HF `livebench/model_judgment` reports 60,372 rows, 195 models, categories language=31,179, coding=21,541, instruction_following=7,652. Coding is the main relevant category for this study.
- BigCodeBench: GitHub releases API listed 10 top-level assets. The latest top-level assets are zips rather than bare `*_eval_results.json`; `deepcoder.zip` contains 2 explicit `_eval_results.json` files, and `sanitized_calibrated_samples.zip` contains per-model calibrated JSONL outcome samples. It has deployable-adjacent rows for DeepSeek/Gemini/Llama families, but lags the newest GPT-5/Claude-4/Kimi/Qwen3-Coder/Gemini-3 frontier.
- Terminal-Bench: HF `yoonholee/terminalbench-trajectories` reports 52,104 rows, 49 model strings, 26 agents. This is the strongest deployable-frontier source found.

## Methods and commands / URLs

- Read spec sections: `/workspace/docs/fusion/capability-index-spec.md` lines 617-716 and 1597-1645.
- Read deployable repo sources: `/workspace/spec/registry/model-catalog.json`, `/workspace/python/fusionkit-core/src/fusionkit_core/registry.py` via `BENCHMARK_PANEL_PRESETS`, and `/workspace/.fusionkit/fusion.json`.
- Created `/workspace/analysis/phase0/cache` and `/workspace/analysis/phase0/scripts`.
- SWE-bench: `git clone --depth 1 --filter=blob:none --sparse https://github.com/swe-bench/experiments /workspace/analysis/phase0/cache/swebench-experiments` then `git -C ... sparse-checkout set evaluation/lite evaluation/verified evaluation/test`.
- LLMRouterBench: `git clone --depth 1 https://github.com/ynulihao/LLMRouterBench /workspace/analysis/phase0/cache/LLMRouterBench`; queried `https://huggingface.co/api/datasets/NPULH/LLMRouterBench/tree/main?recursive=true` and read README/download notes.
- LiveBench: queried `https://datasets-server.huggingface.co/info?dataset=livebench%2Fmodel_judgment`, `/first-rows?dataset=livebench%2Fmodel_judgment&config=default&split=leaderboard`, and `/parquet?dataset=livebench%2Fmodel_judgment`; used DuckDB over the parquet URL.
- BigCodeBench: queried `https://api.github.com/repos/bigcode-project/bigcodebench/releases`; downloaded release assets `sanitized_calibrated_samples.zip` and `deepcoder.zip` into cache and enumerated them with Python `zipfile`.
- Terminal-Bench: queried `https://datasets-server.huggingface.co/info?dataset=yoonholee%2Fterminalbench-trajectories`, `/first-rows?dataset=yoonholee%2Fterminalbench-trajectories&config=default&split=train`, and `/parquet?dataset=yoonholee%2Fterminalbench-trajectories`; used DuckDB over the parquet URLs.
- Collector command: `uv run --with pyyaml --with duckdb python /workspace/analysis/phase0/scripts/collect_c0_coverage.py`.

## Access failures / limitations

- LiveBench `/first-rows` with `split=train` returned 404; corrected to `split=leaderboard`.
- LLMRouterBench result bundle is 1.28 GB and was not downloaded; counts use README/HF manifest model-pool and dataset-size evidence.
- SWE-bench sparse checkout did not materialize `all_preds.jsonl`; row counts use known split sizes and resolved-list counts.
- BigCodeBench release API did not expose top-level bare `*_eval_results.json` assets; explicit eval-result JSONs were inside `deepcoder.zip`.
