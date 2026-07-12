# Generation-0 hypergrid preview (DRAFT -- no experiments started)

Materialized cells: 13 (2 anchors + 11 open solos); 1430 shards at the screen rung.

## Cells (from gen0.Gen0.cells)

| label | sut | model | instances | cell_id | est. cost |
|---|---|---|---|---|---|
| anchor-gpt55 | solo-model | openai/gpt-5.5 | 110 | `3c34a3e236a5` | $20.90 |
| anchor-opus48 | solo-model | anthropic/claude-opus-4.8 | 110 | `7e1143c4a3db` | $17.60 |
| solo-ds32 | solo-model | deepseek/deepseek-v3.2 | 110 | `7f491779f6aa` | $0.26 |
| solo-dsv4pro | solo-model | deepseek/deepseek-v4-pro | 110 | `c02dd7886737` | $0.86 |
| solo-glm52 | solo-model | z-ai/glm-5.2 | 110 | `6e5778fbd638` | $1.25 |
| solo-kimi26 | solo-model | moonshotai/kimi-k2.6 | 110 | `ebb135b4f735` | $3.15 |
| solo-kimikt | solo-model | moonshotai/kimi-k2-thinking | 110 | `e27fc17210ab` | $3.43 |
| solo-nemotron3s | solo-model | nvidia/nemotron-3-super-120b-a12b | 110 | `14af09b9f15f` | $0.41 |
| solo-qwen37max | solo-model | qwen/qwen3.7-max | 110 | `d3e430957fbf` | $3.58 |
| solo-qwen3c | solo-model | qwen/qwen3-coder | 110 | `74a448cfd8c0` | $1.04 |
| solo-qwen3t | solo-model | qwen/qwen3-235b-a22b-thinking-2507 | 110 | `74e87a7524cc` | $2.01 |
| solo-r1 | solo-model | deepseek/deepseek-r1-0528 | 110 | `fc327fb433f8` | $2.95 |
| solo-terminus | solo-model | deepseek/deepseek-v3.1-terminus | 110 | `53b7795af454` | $0.58 |

Solo screen + anchors estimated total: **$58.02**

## Kernel probes (gen 0b -- appended via `hyperkit extend` after the screen)

Panels below are placeholders; the screen's top-2 complementary solos replace them. Costed against a mid-price pair (ds32 + qwen3t).

| kernel | serve/params sketch | calls/task | instances | est. cost |
|---|---|---|---|---|
| judge-synth | `{'default_mode': 'panel', 'synthesis_select_best': False}` | 4 | 60 | $2.47 |
| judge-select | `{'default_mode': 'panel', 'synthesis_select_best': True}` | 3 | 60 | $1.85 |
| self-moa | `{'default_mode': 'self', 'sample_count': 4, 'synthesis_select_best': False, 'sampling': {'temperature': 0.8}}` | 6 | 60 | $3.71 |
| exec-select | `{'n_samples': 3, 'selection': 'public-exec', 'temps': [0.2, 0.6, 0.9]}` | 3 | 60 | $1.85 |

Kernel probes estimated total: **$9.89**

## Generation-0 grand total estimate: **$67.90** (budget gate: $65)

Assumptions: input ~2k tokens/task; output tokens/task per endpoint as declared in gen0.OPEN_UNIVERSE (thinking models 12k, others 5-8k). Real spend is metered per shard via ShardResult.cost_usd.
