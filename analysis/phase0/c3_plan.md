# Phase 0 C3 preregistration: same-harness transfer pilot

Written before any billed C3 provider call.

## Objective

Test whether the public-data complementarity signal transfers to FusionKit's own deterministic algorithmic harness. This pilot runs single-shot code generation only: one candidate per model per LiveCodeBench-style task, then deterministic stdin/stdout grading through `fusionkit-evals` `CandidateBank` and `LocalSandbox`.

## Hard budget

- Spend cap: **$60 total API spend**.
- First run: 2 tasks x 2 models smoke, with cost logged.
- Full run starts only after the smoke produces two candidates per task and deterministic pass/fail flags.
- If projected full-run spend exceeds $60, reduce the task count before continuing. Do not run agentic or multi-turn workloads.

## Model set

Planned five-model paired run:

| Endpoint id | Provider | Requested model id | Public mapping used for transfer check |
| --- | --- | --- | --- |
| `gpt55` | OpenAI | `gpt-5.5` | public `gpt-5` / GPT-5 family |
| `sonnet` | Anthropic | `claude-sonnet-4-6` | public `claude-sonnet-4` / Sonnet 4 family |
| `kimi` | OpenRouter | `moonshotai/kimi-k2-thinking` | public `kimi-k2-0905`; variant match |
| `deepseek` | OpenRouter | `deepseek/deepseek-chat` | public `deepseek-v3.1-terminus` / DeepSeek V3 family; if rejected, smoke `deepseek/deepseek-chat-v3` and record the resolved slug |
| `qwen3` | OpenRouter | `qwen/qwen3-coder` | public `Qwen3-8B`; family/variant match |

Anthropic exact-id rule: the first billed smoke call uses `claude-sonnet-4-6`. If Anthropic rejects the model id, fall back to the nearest available Sonnet id in this order: `claude-sonnet-4-5`, `claude-3-7-sonnet-latest`. Record the exact id used in the outcome files and report.

## Task set

- Source: `fusionkit_evals.livecodebench_data.load_problems` over `livecodebench/code_generation_lite`.
- Version: `release_v6` unless the loader rejects it.
- Selection: most recent stdin-only, no-starter-code, medium/hard tasks.
- Preferred contamination window: `contest_date >= 2025-06-01`; if fewer than 60 runnable tasks are available, relax to `2025-01-01` and record the fallback.
- Full pilot target: **60 tasks**. Raise toward 80 only if smoke cost implies substantial budget headroom. Reduce below 60 only if projected spend crosses $60 or the harness/provider failure rate makes the paired matrix too sparse.
- Cluster key: contest date if available in the dataset row; otherwise task id.

## Pre-named K=3 panels

All five models run on all tasks once, so these comparisons are free after bank construction.

| Panel | Members | Rationale |
| --- | --- | --- |
| P1 public-complementarity | `qwen3`, `deepseek`, `kimi` | Best C1 algorithmic public headroom panel among runnable families: Qwen3 + DeepSeek V3 + Kimi K2 on LLMRouterBench LiveCodeBench. |
| P2 top-K-public-average | `gpt55`, `sonnet`, `deepseek` | Top-K by public average among the planned runnable families, using GPT-5/Sonnet/DeepSeek public coverage as the strongest same-harness deployable-family proxies and excluding Gemini because it is not in this C3 runnable set. |
| P3 product-default-restricted | `kimi`, `qwen3`, `deepseek` | Committed `.fusionkit/fusion.json` default runnable members are Kimi + Qwen3; add DeepSeek as the pre-registered third member to make a K=3 panel while keeping the default's runnable core. |

P1 and P3 are intentionally identical under the current runnable/default constraints. The report will call this out rather than pretending they are independent evidence.

## Metrics

Primary artifacts:

- Frozen candidate bank JSON under `analysis/phase0/cache/` (gitignored).
- Compact per-model/task outcome CSV under `analysis/phase0/`.
- Spend ledger under `analysis/phase0/`.

Primary metrics:

1. Per-model pass rates with Wilson 95% CIs.
2. For P1/P2/P3: oracle, best single on the panel's common tasks, headroom, and clustered bootstrap 95% CIs over `cluster_key`.
3. Pairwise failure-dependence sign agreement against public LLMRouterBench pairs where model-family mappings overlap. Signs are `positive` for phi/loss-correlation > +0.05, `near-zero` for [-0.05, +0.05], and `negative` for < -0.05. Public version mismatches are flagged.
4. Optional capture for P1 if spend after candidate generation is below $40: replay judge/fusion on the frozen P1 bank using the committed judge (`moonshotai/kimi-k2-thinking`) if available, otherwise `gpt-5.5`; compute capture as `(p_fused - p_best) / (p_oracle - p_best)`.

## Pass rules

C3 transfer passes only if both hold:

1. Some pre-named K=3 panel has measured headroom >= 5 percentage points over its best single member on the FusionKit harness, with clustered/task bootstrap CI reported.
2. Pairwise failure-dependence signs agree between public LLMRouterBench and calibrated measured pairs for the overlapping model-family pairs, with variant matches honestly labeled.

If capture is skipped, C3 verdict is still based on the two required rules above and the report records why capture was not run.

## Fallback and remediation plan

If the harness fights the run, try at least three remediation approaches before scaling down:

1. Validate the exact invocation on 2 tasks x 2 models and inspect generated `CandidateBank` shape.
2. Read `tests/test_fusion_bench.py`, `tests/test_prompt_tuning.py`, and `fusionkit_evals.livecodebench_data` / `candidate_bank` source for the expected config and task shapes.
3. Reduce concurrency and/or task count, preserving paired model coverage before breadth.
4. If a single provider/model id is unavailable, smoke the pre-registered fallback slug and keep the rest of the matrix paired.

All fallbacks are recorded in `c3_transfer_report.md`.
