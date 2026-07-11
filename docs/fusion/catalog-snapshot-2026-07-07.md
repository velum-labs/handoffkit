# OpenRouter catalog snapshot - 2026-07-07

Pulled `https://openrouter.ai/api/v1/models` at `2026-07-07T04:52:40Z` with `curl -s`.
This is enumeration only: no benchmark score, rank, or quality cutoff was used.
Endpoint provider options are the top three from each per-model endpoints listing.

## Filter ledger

| Filter | Rule summary | Before | After | Removed |
|---|---|---:|---:|---:|
| open_weights_only | HF id or public open-weights family. | 343 | 191 | 152 |
| context_length | Context length >= 128,000 tokens. | 191 | 165 | 26 |
| recency | Created on/after 2025-07-07. | 165 | 122 | 43 |
| coding_capable | Coding claim or frontier OSS general/reasoning family. | 122 | 59 | 63 |
| free_and_duplicate_variants | Drop free, moving alias, and duplicate variants. | 59 | 34 | 25 |

Rule details:
- `open_weights_only`: keep rows with `hugging_face_id` or a publicly
  open-weights family; exclude closed-only endpoints.
- `context_length`: keep rows with `context_length >= 128000`.
- `recency`: keep OpenRouter `created` on or after 2025-07-07; flag
  2025-07-07 through 2026-01-06 as `aging`.
- `coding_capable`: keep explicit coding models or frontier-class
  general/reasoning OSS families; exclude specialist, vision-only/multimodal
  without coding claim, guard/safety, roleplay, embedding, and tiny variants.
- `free_and_duplicate_variants`: exclude `:free` variants, moving aliases,
  preview/experimental aliases, and superseded dated service variants where a
  canonical paid slug exists.

## Candidates

| Slug | Family | Input $/M | Output $/M | Context | Created | Flags |
|---|---|---:|---:|---:|---|---|
| `deepseek/deepseek-v3.2` | deepseek-v3 | 0.2288 | 0.3432 | 131072 | 2025-12 | aging |
| `deepseek/deepseek-v4-flash` | deepseek-v4 | 0.09 | 0.18 | 1048576 | 2026-04 |  |
| `deepseek/deepseek-v4-pro` | deepseek-v4 | 0.435 | 0.87 | 1048576 | 2026-04 |  |
| `minimax/minimax-m2.7` | minimax-m2 | 0.18 | 0.72 | 204800 | 2026-03 |  |
| `minimax/minimax-m3` | minimax-m3 | 0.3 | 1.2 | 1048576 | 2026-05 |  |
| `mistralai/devstral-2512` | devstral-2 | 0.4 | 2.0 | 262144 | 2025-12 | aging |
| `mistralai/mistral-large-2512` | mistral-large-3 | 0.5 | 1.5 | 262144 | 2025-12 | aging |
| `mistralai/mistral-small-2603` | mistral-small-4 | 0.15 | 0.6 | 262144 | 2026-03 |  |
| `moonshotai/kimi-k2-thinking` | kimi-k2 | 0.6 | 2.5 | 262144 | 2025-11 | aging |
| `moonshotai/kimi-k2.6` | kimi-k2 | 0.66 | 3.41 | 262144 | 2026-04 |  |
| `moonshotai/kimi-k2.7-code` | kimi-k2 | 0.74 | 3.5 | 262144 | 2026-06 |  |
| `nex-agi/nex-n2-pro` | nex-n2 | 0.25 | 1.0 | 262144 | 2026-06 |  |
| `nousresearch/hermes-4-405b` | llama-3.1-hermes-4-405b | 1.0 | 3.0 | 131072 | 2025-08 | aging |
| `nousresearch/hermes-4-70b` | llama-3.1-hermes-4-70b | 0.13 | 0.4 | 131072 | 2025-08 | aging |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | llama-3.3-nemotron | 0.4 | 0.4 | 131072 | 2025-10 | aging |
| `nvidia/nemotron-3-super-120b-a12b` | nemotron-3-super | 0.08 | 0.45 | 1000000 | 2026-03 |  |
| `nvidia/nemotron-3-ultra-550b-a55b` | nemotron-3-ultra | 0.5 | 2.2 | 1000000 | 2026-06 |  |
| `openai/gpt-oss-120b` | gpt-oss | 0.03 | 0.15 | 131072 | 2025-08 | aging |
| `poolside/laguna-m.1` | laguna-m | 0.2 | 0.4 | 262144 | 2026-04 |  |
| `qwen/qwen3-235b-a22b-2507` | qwen3 | 0.09 | 0.1 | 262144 | 2025-07 | aging |
| `qwen/qwen3-235b-a22b-thinking-2507` | qwen3 | 0.1495 | 1.495 | 262144 | 2025-07 | aging |
| `qwen/qwen3-coder` | qwen3-coder | 0.22 | 1.8 | 1048576 | 2025-07 | aging |
| `qwen/qwen3-max` | qwen3-max | 0.78 | 3.9 | 262144 | 2025-09 | aging |
| `qwen/qwen3-max-thinking` | qwen3-max | 0.78 | 3.9 | 262144 | 2026-02 |  |
| `qwen/qwen3.7-max` | qwen3.7 | 1.25 | 3.75 | 1000000 | 2026-05 |  |
| `qwen/qwen3.7-plus` | qwen3.7 | 0.32 | 1.28 | 1000000 | 2026-06 |  |
| `xiaomi/mimo-v2.5-pro` | mimo-v2.5 | 0.435 | 0.87 | 1048576 | 2026-04 |  |
| `z-ai/glm-4.7` | glm-4.7 | 0.4 | 1.75 | 202752 | 2025-12 | aging |
| `z-ai/glm-4.7-flash` | glm-4.7 | 0.06 | 0.4 | 202752 | 2026-01 |  |
| `z-ai/glm-5` | glm-5 | 0.6 | 1.92 | 202752 | 2026-02 |  |
| `z-ai/glm-5-turbo` | glm-5 | 1.2 | 4.0 | 262144 | 2026-03 |  |
| `z-ai/glm-5.1` | glm-5 | 0.966 | 3.036 | 202752 | 2026-04 |  |
| `z-ai/glm-5.2` | glm-5 | 0.9086 | 2.8556 | 1048576 | 2026-06 |  |
| `z-ai/glm-5v-turbo` | glm-5 | 1.2 | 4.0 | 202752 | 2026-04 |  |

## Judgment calls

- `openai/gpt-oss-120b` was kept because the row has a Hugging Face id and
  the model card describes it as open-weight; closed OpenAI endpoints without
  open-weight evidence were excluded by the open-weights pass.
- `mistralai/mistral-large-2512` was kept without a Hugging Face id because
  the OpenRouter description states it is Apache 2.0 licensed.
- `providers` were not pinned during enumeration. Step 4 provider pins for
  hypothesis members and the judge are now recorded in the YAML snapshot.
- All surviving candidates returned endpoint listings successfully.

### Non-coding exclusions after open/context/recency filters

- `ai21/jamba-large-1.7` - no coding or frontier general/reasoning signal.
- `aion-labs/aion-2.0` - specialist non-coding/safety/creative.
- `arcee-ai/trinity-large-thinking` - no coding or frontier general/reasoning signal.
- `arcee-ai/trinity-mini` - tiny <20B-active or <20B dense variant.
- `bytedance/ui-tars-1.5-7b` - multimodal/vision specialist without coding claim.
- `cohere/north-mini-code:free` - tiny <20B-active or <20B dense variant.
- `google/gemma-4-26b-a4b-it` - tiny <20B-active or <20B dense variant.
- `google/gemma-4-26b-a4b-it:free` - tiny <20B-active or <20B dense variant.
- `google/gemma-4-31b-it` - multimodal/vision specialist without coding claim.
- `google/gemma-4-31b-it:free` - multimodal/vision specialist without coding claim.
- `ibm-granite/granite-4.0-h-micro` - tiny <20B-active or <20B dense variant.
- `ibm-granite/granite-4.1-8b` - tiny <20B-active or <20B dense variant.
- `liquid/lfm-2-24b-a2b` - tiny <20B-active or <20B dense variant.
- `mistralai/ministral-14b-2512` - tiny <20B-active or <20B dense variant.
- `mistralai/ministral-3b-2512` - tiny <20B-active or <20B dense variant.
- `mistralai/ministral-8b-2512` - tiny <20B-active or <20B dense variant.
- `nex-agi/nex-n2-mini` - tiny <20B-active or <20B dense variant.
- `nvidia/nemotron-3-nano-30b-a3b` - tiny <20B-active or <20B dense variant.
- `nvidia/nemotron-3-nano-30b-a3b:free` - tiny <20B-active or <20B dense variant.
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` - multimodal/vision specialist without coding claim.
- `nvidia/nemotron-3.5-content-safety:free` - specialist non-coding/safety/creative.
- `nvidia/nemotron-nano-12b-v2-vl:free` - multimodal/vision specialist without coding claim.
- `nvidia/nemotron-nano-9b-v2:free` - tiny <20B-active or <20B dense variant.
- `openai/gpt-oss-20b` - tiny <20B-active or <20B dense variant.
- `openai/gpt-oss-20b:free` - tiny <20B-active or <20B dense variant.
- `openai/gpt-oss-safeguard-20b` - specialist non-coding/safety/creative.
- `poolside/laguna-xs-2.1` - tiny <20B-active or <20B dense variant.
- `poolside/laguna-xs-2.1:free` - tiny <20B-active or <20B dense variant.
- `poolside/laguna-xs.2` - tiny <20B-active or <20B dense variant.
- `poolside/laguna-xs.2:free` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-30b-a3b-instruct-2507` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-30b-a3b-thinking-2507` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-coder-30b-a3b-instruct` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-coder-next` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-next-80b-a3b-instruct` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-next-80b-a3b-instruct:free` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-next-80b-a3b-thinking` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3-vl-235b-a22b-instruct` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-235b-a22b-thinking` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-30b-a3b-instruct` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-30b-a3b-thinking` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-32b-instruct` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-8b-instruct` - multimodal/vision specialist without coding claim.
- `qwen/qwen3-vl-8b-thinking` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-122b-a10b` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-27b` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-35b-a3b` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-397b-a17b` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-9b` - tiny <20B-active or <20B dense variant.
- `qwen/qwen3.5-flash-02-23` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-plus-02-15` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.5-plus-20260420` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.6-27b` - multimodal/vision specialist without coding claim.
- `qwen/qwen3.6-35b-a3b` - multimodal/vision specialist without coding claim.
- `stepfun/step-3.5-flash` - no coding or frontier general/reasoning signal.
- `stepfun/step-3.7-flash` - multimodal/vision specialist without coding claim.
- `tencent/hunyuan-a13b-instruct` - no coding or frontier general/reasoning signal.
- `tencent/hy3` - no coding or frontier general/reasoning signal.
- `tencent/hy3-preview` - no coding or frontier general/reasoning signal.
- `tencent/hy3:free` - no coding or frontier general/reasoning signal.
- `thedrummer/cydonia-24b-v4.1` - specialist non-coding/safety/creative.
- `xiaomi/mimo-v2.5` - multimodal/vision specialist without coding claim.
- `z-ai/glm-4.6v` - multimodal/vision specialist without coding claim.

### Free, alias, and duplicate variant exclusions

- `deepseek/deepseek-chat-v3.1` - superseded DeepSeek V3.1 variant; kept deepseek/deepseek-v3.2 and V4 variants.
- `deepseek/deepseek-v3.1-terminus` - superseded DeepSeek V3.1 Terminus variant; kept deepseek/deepseek-v3.2 and V4 variants.
- `deepseek/deepseek-v3.2-exp` - experimental alias; kept stable deepseek/deepseek-v3.2.
- `minimax/minimax-m2` - superseded MiniMax M2 variant; kept minimax/minimax-m2.7.
- `minimax/minimax-m2.1` - superseded MiniMax M2 variant; kept minimax/minimax-m2.7.
- `minimax/minimax-m2.5` - superseded MiniMax M2 variant; kept minimax/minimax-m2.7.
- `moonshotai/kimi-k2` - superseded Kimi K2 0711 variant; kept newer Kimi K2 slugs.
- `moonshotai/kimi-k2-0905` - superseded Kimi K2 0905 variant; kept newer Kimi K2 slugs.
- `moonshotai/kimi-k2.5` - superseded Kimi K2.5 variant; kept moonshotai/kimi-k2.6 and code/thinking variants.
- `nvidia/nemotron-3-super-120b-a12b:free` - excluded :free rate-limited variant.
- `nvidia/nemotron-3-ultra-550b-a55b:free` - excluded :free rate-limited variant.
- `openai/gpt-oss-120b:free` - excluded :free rate-limited variant.
- `poolside/laguna-m.1:free` - excluded :free rate-limited variant.
- `qwen/qwen-plus-2025-07-28` - superseded Qwen Plus dated variant; kept qwen/qwen3.7-plus.
- `qwen/qwen-plus-2025-07-28:thinking` - superseded Qwen Plus dated thinking variant; kept qwen/qwen3-max-thinking.
- `qwen/qwen3-coder-flash` - hosted Qwen3 Coder service variant; kept canonical qwen/qwen3-coder.
- `qwen/qwen3-coder-plus` - hosted Qwen3 Coder service variant; kept canonical qwen/qwen3-coder.
- `qwen/qwen3-coder:free` - excluded :free rate-limited variant.
- `qwen/qwen3.6-flash` - superseded Qwen Flash generation; kept current Plus/Max/Coder slugs.
- `qwen/qwen3.6-max-preview` - preview variant; kept qwen/qwen3.7-max.
- `qwen/qwen3.6-plus` - superseded Qwen Plus generation; kept qwen/qwen3.7-plus.
- `z-ai/glm-4.5` - superseded GLM 4.x variant; kept GLM 4.7 and GLM 5 variants.
- `z-ai/glm-4.5-air` - superseded GLM 4.x Air variant; kept GLM 4.7 Flash and GLM 5 variants.
- `z-ai/glm-4.6` - superseded GLM 4.x variant; kept GLM 4.7 and GLM 5 variants.
- `~moonshotai/kimi-latest` - excluded moving alias; canonical paid slug exists.

## Provenance

- Filtered raw surviving OpenRouter rows: `/workspace/labruns/2026-q3/catalog/openrouter-rows-2026-07-07.json`
- Machine-readable snapshot: `/workspace/docs/fusion/catalog-snapshot-2026-07-07.yaml`

## Evidence collection notes (Step 3)

Retrieved public benchmark pages on 2026-07-07:

- LiveCodeBench rolling mirror: `https://llm-stats.com/benchmarks/livecodebench`
  - Saturated: no. Top 10 range is 0.794-0.935, so the top 10 are not all above ~85%.
  - Used when exact or clearly configurable rows appeared on the rolling leaderboard.
- LiveCodeBench v6 mirror: `https://llm-stats.com/benchmarks/livecodebench-v6`
  - Saturated: yes. The top 10 are approximately 84.9%-91.6%, so v6 should not be used later as a primary anchor without this caveat.
  - Used only for candidates absent from the rolling page but present on the v6 table.
- Aider official polyglot leaderboard: `https://aider.chat/docs/leaderboards/`
  - Saturated: no. The top 10 include multiple rows below 85%.
- SWE-bench Pro: `https://benchlm.ai/benchmarks/swePro` and `https://llm-stats.com/benchmarks/swe-bench-pro`
  - Saturated: no. Top scores remain below 85%.
  - BenchLM provided broader candidate coverage; LLM Stats was used as a cross-check.
- Artificial Analysis Coding Index: `https://artificialanalysis.ai/models/capabilities/coding`
  - Saturated: no. Top Coding Index scores remain below 85.

Coverage across the 34 candidates after Step 3:

- `livecodebench`: 24 candidates with scores, 19 third-party and 5 vendor-claimed.
- `swe-bench-pro`: 16 candidates with scores, 13 third-party and 3 vendor-claimed.
- `aider-polyglot`: 3 candidates with scores, 2 third-party and 1 vendor-claimed.
- `artificial_analysis_coding_index`: 10 candidates with scores, all third-party.

Candidates with no usable public coding aggregate found and `aggregate-none` flag added:

- `nvidia/llama-3.3-nemotron-super-49b-v1.5`
- `z-ai/glm-5-turbo`
- `z-ai/glm-5v-turbo`

Naming-match and trust notes:

- DeepSeek V4 rows often publish max/high-effort variants; those are recorded in `harness` for the generic OpenRouter V4 Flash/Pro slugs.
- `moonshotai/kimi-k2-thinking` maps to a dated `Kimi K2-Thinking-0905` LiveCodeBench v6 row.
- `openai/gpt-oss-120b` maps to high-reasoning rows on LiveCodeBench v6 and Aider.
- `qwen/qwen3-235b-a22b-2507` maps to Aider's "no think, Alibaba API" row and LiveCodeBench v6's instruct row.
- `qwen/qwen3-coder`, `moonshotai/kimi-k2.7-code`, `nex-agi/nex-n2-pro`, `qwen/qwen3-max-thinking`, `nousresearch/hermes-4-405b`, and `z-ai/glm-4.7-flash` only had vendor-claimed or source-reported fallback data for the collected anchors; entries are marked `trust: vendor-claimed`.

## Shortlist (Step 4)

Ranking method: simple unweighted mean of each candidate's third-party,
unsaturated benchmark scores. `trust: vendor-claimed` entries and
`saturated: true` benchmark rows were excluded. Some source pages report
pass rates as fractions while others report percentages; fractional pass rates
were converted to the required 0-100 scale before taking the mean. The
leaderboards still use different harnesses and scales, so this is a shortlist
heuristic only, not a final panel ranking.

Known limitation (recorded, not corrected post-hoc): benchmark coverage is
asymmetric. Ranks 1-2 rest on a single benchmark (LiveCodeBench rolling,
where scores run high), while lower ranks average in SWE-bench Pro (where
scores run much lower). A model measured only on LiveCodeBench therefore
ranks above a model with broader-but-harder coverage. The pre-committed rule
("simple unweighted mean of available unsaturated benchmarks") was applied as
written; changing the method after seeing the ranking would violate the
clean-room discipline. Phase C measures all shortlisted models on our own
harness, which supersedes this heuristic. Flag for the next cycle's rules
revision: consider requiring >= 2 unsaturated benchmarks for backbone
eligibility.

Frontier anchor price envelope: current GPT-5.5-class standard API pricing is
$5/M input and $30/M output tokens, with provenance from
`https://aicost.tools/llm-cost/openai/gpt-5-5/` and corroborating public price
trackers retrieved on 2026-07-07. At the default non-thinking budget
(~2k input + ~8k output), the anchor costs `(2,000 * 5 + 8,000 * 30) / 1e6 =
$0.2500` per request, so the Step 4 one-third envelope is about `$0.0833` for
panel members collectively. The selected H1, H2, and H5 panel-member
projections are approximately `$0.0148`, `$0.0316`, and `$0.0806`,
respectively, before judge calls. `nvidia/nemotron-3-super-120b-a12b`,
`deepseek/deepseek-v4-flash`, `mistralai/mistral-small-2603`, and
`qwen/qwen3-235b-a22b-2507` satisfy the <= $0.20/M input cascade-fodder
requirement. No bridge model is required in the Step 4 backbone shortlist.

No complementarity search, oracle maximization, public per-task matrix
analysis, weighting, or normalization beyond 0-100 scale conversion was run.
Candidates with `aggregate_mean: null` remain ineligible for H1 backbone
selection.

| Rank | Slug | Aggregate mean | Benchmarks contributed | Family | Flags |
|---:|---|---:|---|---|---|
| 1 | `deepseek/deepseek-v3.2` | 83.30 | livecodebench | deepseek-v3 | aging; pinned StreamLake |
| 2 | `nvidia/nemotron-3-super-120b-a12b` | 81.20 | livecodebench | nemotron-3-super | <= $0.20/M input; pinned DeepInfra |
| 3 | `deepseek/deepseek-v4-pro` | 68.32 | livecodebench; swe-bench-pro; artificial_analysis_coding_index | deepseek-v4 | pinned DeepSeek |
| 4 | `deepseek/deepseek-v4-flash` | 65.62 | livecodebench; swe-bench-pro; artificial_analysis_coding_index | deepseek-v4 | <= $0.20/M input |
| 5 | `z-ai/glm-5.2` | 65.43 | swe-bench-pro; artificial_analysis_coding_index | glm-5 | pinned Novita |
| 6 | `mistralai/mistral-small-2603` | 63.60 | livecodebench | mistral-small-4 | <= $0.20/M input |
| 7 | `qwen/qwen3.7-max` | 63.28 | swe-bench-pro; artificial_analysis_coding_index | qwen3.7 | judge pinned Alibaba |
| 8 | `moonshotai/kimi-k2.6` | 60.18 | swe-bench-pro; artificial_analysis_coding_index | kimi-k2 | pinned Decart |
| 9 | `qwen/qwen3-235b-a22b-2507` | 59.60 | aider-polyglot | qwen3 | aging; <= $0.20/M input |
| 10 | `minimax/minimax-m3` | 58.78 | swe-bench-pro; artificial_analysis_coding_index | minimax-m3 |  |
| 11 | `xiaomi/mimo-v2.5-pro` | 58.69 | swe-bench-pro; artificial_analysis_coding_index | mimo-v2.5 |  |
| 12 | `z-ai/glm-5.1` | 58.40 | swe-bench-pro | glm-5 |  |

## Visual briefing

Open `analysis/phase-a-briefing-2026-07-07/phase_a_briefing.html` in a browser
for a self-contained walkthrough: filter funnel, price-vs-score scatter,
evidence coverage matrix, shortlist table, and all five hypothesis cards.
Regenerate after snapshot or card changes:

```bash
uv run python analysis/phase-a-briefing-2026-07-07/scripts/build_briefing.py
```
