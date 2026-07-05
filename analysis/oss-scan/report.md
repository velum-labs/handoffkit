# OSS peer-field scan

Public-data-only scan for OSS-first ensemble shortlists. No billed provider APIs are used; all numbers regenerate from cached/public benchmark rows.

## Per-domain verdicts

| domain | verdict | OSS universe | #1-#2 gap | best panel oracle | best panel headroom |
| --- | --- | --- | --- | --- | --- |
| algorithmic_lcb | peer-shaped | 31 | +1.7 pp | 79.0% | +11.3 pp |
| mbpp_humaneval | peer-shaped | 20 | +6.0 pp | 84.4% | +22.7 pp |
| repo_bugfix_model | peer-shaped | 8 | +3.2 pp | 45.6% | +17.0 pp |
| repo_bugfix_system_verified | peer-shaped | 15 | +5.8 pp | 66.4% | +13.0 pp |
| repo_bugfix_system_test | insufficient OSS universe | 0 | NA | NA | NA |
| terminal_agentic | peer-shaped | 20 | +9.2 pp | 50.1% | +13.5 pp |

Plain-language read: peer-shaped domains with positive headroom are the best candidates for capture pilots; lopsided domains should start as single-model routing baselines.

## Algorithmic / LiveCodeBench (LLMRouterBench)

- Tier: A.
- Algorithmic rows are raw model outputs, so this is the cleanest OSS field-shape signal.
- Verdict: **peer-shaped**; OSS universe=31 systems, common task set n=1055, #1-#2 gap +1.7 pp, #1-#5 spread +12.4 pp.
- Closed/frontier anchor: gpt-5 at 86.4%.

### Field shape

| model | avg score | gap to #1 | tier | OSS classification note |
| --- | --- | --- | --- | --- |
| deepseek-r1-0528 | 80.1% | +0.0 pp | A | all tagged models are OSS/open-weights |
| qwen3-235b-a22b-thinking-2507 | 78.4% | +1.7 pp | A | all tagged models are OSS/open-weights |
| qwen3-235b-a22b-thinking | 78.1% | +2.0 pp | A | all tagged models are OSS/open-weights |
| intern-s1-new | 75.6% | +4.5 pp | A | all tagged models are OSS/open-weights |
| Qwen3-8B | 67.7% | +12.4 pp | A | all tagged models are OSS/open-weights |
| deepseek-v3.1-terminus | 67.3% | +12.8 pp | A | all tagged models are OSS/open-weights |
| kimi-k2-0905 | 67.3% | +12.8 pp | A | all tagged models are OSS/open-weights |
| deepseek-v3-0324 | 66.6% | +13.5 pp | A | all tagged models are OSS/open-weights |

Interpretation: the top OSS models are close enough for ensemble pilots.

### Top OSS-only panels by oracle headroom

| K | panel | oracle | best single | headroom | 95% CI | n | pairwise phi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | Qwen3-8B \| deepseek-v3.1-terminus \| kimi-k2-0905 | 79.0% | 67.7% | +11.3 pp | [+9.3 pp, +12.2 pp] | 1055 | Qwen3-8B / deepseek-v3.1-terminus: 0.594; Qwen3-8B / kimi-k2-0905: 0.594; deepseek-v3.1-terminus / kimi-k2-0905: 0.660 |
| 3 | Qwen3-8B \| kimi-k2-0905 \| deepseek-v3-0324 | 78.2% | 67.7% | +10.5 pp | [+8.5 pp, +11.6 pp] | 1055 | Qwen3-8B / kimi-k2-0905: 0.594; Qwen3-8B / deepseek-v3-0324: 0.628; kimi-k2-0905 / deepseek-v3-0324: 0.685 |
| 2 | Qwen3-8B \| deepseek-v3.1-terminus | 76.4% | 67.7% | +8.7 pp | [+6.9 pp, +9.7 pp] | 1055 | Qwen3-8B / deepseek-v3.1-terminus: 0.594 |
| 2 | Qwen3-8B \| kimi-k2-0905 | 76.4% | 67.7% | +8.7 pp | [+7.0 pp, +9.8 pp] | 1055 | Qwen3-8B / kimi-k2-0905: 0.594 |
| 2 | Qwen3-8B \| deepseek-v3-0324 | 75.4% | 67.7% | +7.7 pp | [+6.1 pp, +8.7 pp] | 1055 | Qwen3-8B / deepseek-v3-0324: 0.628 |

Interpretation: the oracle is a ceiling, not an achieved fused score; positive headroom means the members solve different tasks.

### Shortlist and lineage vetoes

| candidate | avg score | lineage | veto flags |
| --- | --- | --- | --- |
| deepseek-r1-0528 | 80.1% | base=DeepSeek-R1; teacher=none; DeepSeek-R1 open-weights reasoning family | none |
| qwen3-235b-a22b-thinking-2507 | 78.4% | base=Qwen3-235B-A22B; teacher=none; Qwen3 MoE open-weights family | qwen3-235b-a22b-thinking-2507 <> qwen3-235b-a22b-thinking (shared lineage; phi=0.702; floors met) |
| qwen3-235b-a22b-thinking | 78.1% | base=Qwen3-235B-A22B; teacher=none; Qwen3 MoE open-weights family | qwen3-235b-a22b-thinking <> qwen3-235b-a22b-thinking-2507 (shared lineage; phi=0.702; floors met) |
| intern-s1-new | 75.6% | base=Intern-S1; teacher=none; InternLM open-weights family | none |
| Qwen3-8B | 67.7% | base=Qwen3-8B; teacher=none; Qwen3 open-weights family | none |
| deepseek-v3.1-terminus | 67.3% | base=DeepSeek-V3; teacher=none; DeepSeek-V3 open-weights family | deepseek-v3.1-terminus <> deepseek-v3-0324 (shared lineage; phi=0.668; floors met) |
| kimi-k2-0905 | 67.3% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | none |
| deepseek-v3-0324 | 66.6% | base=DeepSeek-V3; teacher=none; DeepSeek-V3 open-weights family | deepseek-v3-0324 <> deepseek-v3.1-terminus (shared lineage; phi=0.668; floors met) |

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## MBPP + HumanEval secondary coding (LLMRouterBench)

- Tier: A.
- This secondary codegen slice is easier and older than LCB, but useful for small-model complementarity.
- Verdict: **peer-shaped**; OSS universe=20 systems, common task set n=1137, #1-#2 gap +6.0 pp, #1-#5 spread +13.6 pp.
- Closed/frontier anchor: none identified in this source.

### Field shape

| model | avg score | gap to #1 | tier | OSS classification note |
| --- | --- | --- | --- | --- |
| Qwen2.5-Coder-7B-Instruct | 76.3% | +0.0 pp | A | all tagged models are OSS/open-weights |
| Fin-R1 | 70.3% | +6.0 pp | A | all tagged models are OSS/open-weights |
| glm-4-9b-chat | 64.6% | +11.7 pp | A | all tagged models are OSS/open-weights |
| gemma-2-9b-it | 62.8% | +13.5 pp | A | all tagged models are OSS/open-weights |
| GLM-Z1-9B-0414 | 62.6% | +13.6 pp | A | all tagged models are OSS/open-weights |
| Llama-3.1-Nemotron-Nano-8B-v1 | 61.7% | +14.5 pp | A | all tagged models are OSS/open-weights |
| internlm3-8b-instruct | 61.3% | +15.0 pp | A | all tagged models are OSS/open-weights |
| Llama-3.1-8B-Instruct | 60.9% | +15.4 pp | A | all tagged models are OSS/open-weights |

Interpretation: the top OSS models are close enough for ensemble pilots.

### Top OSS-only panels by oracle headroom

| K | panel | oracle | best single | headroom | 95% CI | n | pairwise phi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | Llama-3.1-Nemotron-Nano-8B-v1 \| internlm3-8b-instruct \| Llama-3.1-8B-Instruct | 84.4% | 61.7% | +22.7 pp | [+20.2 pp, +23.9 pp] | 1137 | Llama-3.1-Nemotron-Nano-8B-v1 / internlm3-8b-instruct: 0.233; Llama-3.1-Nemotron-Nano-8B-v1 / Llama-3.1-8B-Instruct: 0.386; internlm3-8b-instruct / Llama-3.1-8B-Instruct: 0.303 |
| 3 | gemma-2-9b-it \| GLM-Z1-9B-0414 \| internlm3-8b-instruct | 85.4% | 62.8% | +22.6 pp | [+20.1 pp, +23.8 pp] | 1137 | gemma-2-9b-it / GLM-Z1-9B-0414: 0.354; gemma-2-9b-it / internlm3-8b-instruct: 0.330; GLM-Z1-9B-0414 / internlm3-8b-instruct: 0.200 |
| 3 | GLM-Z1-9B-0414 \| internlm3-8b-instruct \| Llama-3.1-8B-Instruct | 85.1% | 62.6% | +22.5 pp | [+20.2 pp, +24.0 pp] | 1137 | GLM-Z1-9B-0414 / internlm3-8b-instruct: 0.200; GLM-Z1-9B-0414 / Llama-3.1-8B-Instruct: 0.394; internlm3-8b-instruct / Llama-3.1-8B-Instruct: 0.303 |
| 3 | GLM-Z1-9B-0414 \| Llama-3.1-Nemotron-Nano-8B-v1 \| internlm3-8b-instruct | 84.7% | 62.6% | +22.1 pp | [+19.6 pp, +23.6 pp] | 1137 | GLM-Z1-9B-0414 / Llama-3.1-Nemotron-Nano-8B-v1: 0.545; GLM-Z1-9B-0414 / internlm3-8b-instruct: 0.200; Llama-3.1-Nemotron-Nano-8B-v1 / internlm3-8b-instruct: 0.233 |
| 3 | gemma-2-9b-it \| Llama-3.1-Nemotron-Nano-8B-v1 \| internlm3-8b-instruct | 84.7% | 62.8% | +21.9 pp | [+19.5 pp, +23.4 pp] | 1137 | gemma-2-9b-it / Llama-3.1-Nemotron-Nano-8B-v1: 0.398; gemma-2-9b-it / internlm3-8b-instruct: 0.330; Llama-3.1-Nemotron-Nano-8B-v1 / internlm3-8b-instruct: 0.233 |

Interpretation: the oracle is a ceiling, not an achieved fused score; positive headroom means the members solve different tasks.

### Shortlist and lineage vetoes

| candidate | avg score | lineage | veto flags |
| --- | --- | --- | --- |
| Qwen2.5-Coder-7B-Instruct | 76.3% | base=Qwen2.5-Coder; teacher=none; Qwen2.5-Coder open-weights family | none |
| Fin-R1 | 70.3% | base=unknown; teacher=DeepSeek-R1 (uncertain); R1-style open fine-tune; base uncertain | none |
| glm-4-9b-chat | 64.6% | base=GLM-4-9B; teacher=none; Z.ai GLM open-weights family | glm-4-9b-chat <> GLM-Z1-9B-0414 (shared lineage; phi=0.360; floors met) |
| gemma-2-9b-it | 62.8% | base=Gemma-2-9B; teacher=none; Google Gemma open-weights family | none |
| GLM-Z1-9B-0414 | 62.6% | base=GLM-4-9B; teacher=GLM-Z1/RL (uncertain); Z.ai GLM-Z1 open reasoning family | GLM-Z1-9B-0414 <> glm-4-9b-chat (shared lineage; phi=0.360; floors met) |
| Llama-3.1-Nemotron-Nano-8B-v1 | 61.7% | base=Llama-3.1; teacher=NVIDIA Nemotron alignment (uncertain); NVIDIA Nemotron derivative of Llama | none |
| internlm3-8b-instruct | 61.3% | base=InternLM3-8B; teacher=none; InternLM open-weights family | none |
| Llama-3.1-8B-Instruct | 60.9% | base=Llama-3.1-8B; teacher=none; Meta Llama open-weights family | none |

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## Repo bugfix model-level / SWE-Bench Verified (LLMRouterBench)

- Tier: A.
- This is model-level SWE-Bench evidence without agent scaffold confounds.
- Verdict: **peer-shaped**; OSS universe=8 systems, common task set n=500, #1-#2 gap +3.2 pp, #1-#5 spread +6.8 pp.
- Closed/frontier anchor: claude-opus-4.1 at 41.6%.

### Field shape

| model | avg score | gap to #1 | tier | OSS classification note |
| --- | --- | --- | --- | --- |
| deepseek-r1-0528 | 28.6% | +0.0 pp | A | all tagged models are OSS/open-weights |
| deepseek-v3.1-terminus | 25.4% | +3.2 pp | A | all tagged models are OSS/open-weights |
| deepseek-v3-0324 | 25.0% | +3.6 pp | A | all tagged models are OSS/open-weights |
| kimi-k2-0905 | 23.4% | +5.2 pp | A | all tagged models are OSS/open-weights |
| glm-4.6 | 21.8% | +6.8 pp | A | all tagged models are OSS/open-weights |
| qwen3-235b-a22b-thinking-2507 | 21.4% | +7.2 pp | A | all tagged models are OSS/open-weights |
| qwen3-235b-a22b-2507 | 16.2% | +12.4 pp | A | all tagged models are OSS/open-weights |
| intern-s1 | 7.8% | +20.8 pp | A | all tagged models are OSS/open-weights |

Interpretation: the top OSS models are close enough for ensemble pilots.

### Top OSS-only panels by oracle headroom

| K | panel | oracle | best single | headroom | 95% CI | n | pairwise phi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | deepseek-r1-0528 \| deepseek-v3.1-terminus \| qwen3-235b-a22b-thinking-2507 | 45.6% | 28.6% | +17.0 pp | [+14.3 pp, +20.5 pp] | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / qwen3-235b-a22b-thinking-2507: 0.306; deepseek-v3.1-terminus / qwen3-235b-a22b-thinking-2507: 0.345 |
| 3 | deepseek-r1-0528 \| deepseek-v3.1-terminus \| glm-4.6 | 45.4% | 28.6% | +16.8 pp | [+14.4 pp, +20.3 pp] | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / glm-4.6: 0.298; deepseek-v3.1-terminus / glm-4.6: 0.360 |
| 3 | deepseek-r1-0528 \| deepseek-v3.1-terminus \| kimi-k2-0905 | 45.2% | 28.6% | +16.6 pp | [+14.2 pp, +18.7 pp] | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / kimi-k2-0905: 0.361; deepseek-v3.1-terminus / kimi-k2-0905: 0.426 |
| 3 | deepseek-v3-0324 \| kimi-k2-0905 \| qwen3-235b-a22b-thinking-2507 | 41.4% | 25.0% | +16.4 pp | [+11.0 pp, +18.4 pp] | 500 | deepseek-v3-0324 / kimi-k2-0905: 0.412; deepseek-v3-0324 / qwen3-235b-a22b-thinking-2507: 0.329; kimi-k2-0905 / qwen3-235b-a22b-thinking-2507: 0.345 |
| 3 | kimi-k2-0905 \| glm-4.6 \| qwen3-235b-a22b-thinking-2507 | 39.6% | 23.4% | +16.2 pp | [+12.1 pp, +19.3 pp] | 500 | kimi-k2-0905 / glm-4.6: 0.429; kimi-k2-0905 / qwen3-235b-a22b-thinking-2507: 0.345; glm-4.6 / qwen3-235b-a22b-thinking-2507: 0.362 |

Interpretation: the oracle is a ceiling, not an achieved fused score; positive headroom means the members solve different tasks.

### Shortlist and lineage vetoes

| candidate | avg score | lineage | veto flags |
| --- | --- | --- | --- |
| deepseek-r1-0528 | 28.6% | base=DeepSeek-R1; teacher=none; DeepSeek-R1 open-weights reasoning family | none |
| deepseek-v3.1-terminus | 25.4% | base=DeepSeek-V3; teacher=none; DeepSeek-V3 open-weights family | deepseek-v3.1-terminus <> deepseek-v3-0324 (shared lineage; phi=0.448; floors met) |
| deepseek-v3-0324 | 25.0% | base=DeepSeek-V3; teacher=none; DeepSeek-V3 open-weights family | deepseek-v3-0324 <> deepseek-v3.1-terminus (shared lineage; phi=0.448; floors met) |
| kimi-k2-0905 | 23.4% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | none |
| glm-4.6 | 21.8% | base=GLM-4.6; teacher=none; Z.ai GLM open-weights family | none |
| qwen3-235b-a22b-thinking-2507 | 21.4% | base=Qwen3-235B-A22B; teacher=none; Qwen3 MoE open-weights family | qwen3-235b-a22b-thinking-2507 <> qwen3-235b-a22b-2507 (shared lineage; phi=0.313; floors met) |
| qwen3-235b-a22b-2507 | 16.2% | base=Qwen3-235B-A22B; teacher=none; Qwen3 MoE open-weights family | qwen3-235b-a22b-2507 <> qwen3-235b-a22b-thinking-2507 (shared lineage; phi=0.313; floors met) |
| intern-s1 | 7.8% | base=Intern-S1; teacher=none; InternLM open-weights family | none |

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## Repo bugfix system-level / SWE-bench Verified experiments

- Tier: A- system-level.
- This is scaffold-confounded A- evidence, but it is closest to agentic bug fixing demand.
- Verdict: **peer-shaped**; OSS universe=15 systems, common task set n=500, #1-#2 gap +5.8 pp, #1-#5 spread +17.8 pp.
- Closed/frontier anchor: Sonar Foundation Agent + Claude 4.5 Opus [20251205_sonar-foundation-agent_claude-opus-4-5] at 79.2%.

### Field shape

| model | avg score | gap to #1 | tier | OSS classification note |
| --- | --- | --- | --- | --- |
| Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] | 71.2% | +0.0 pp | A- system-level | all tagged models are OSS/open-weights |
| OpenHands + Kimi K2 [20250716_openhands_kimi_k2] | 65.4% | +5.8 pp | A- system-level | all tagged models are OSS/open-weights |
| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B_tts] | 60.4% | +10.8 pp | A- system-level | all tagged models are OSS/open-weights |
| DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] | 58.8% | +12.4 pp | A- system-level | all tagged models are OSS/open-weights |
| CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] | 53.4% | +17.8 pp | A- system-level | all tagged models are OSS/open-weights |
| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] | 52.2% | +19.0 pp | A- system-level | all tagged models are OSS/open-weights |
| Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8] | 47.0% | +24.2 pp | A- system-level | all tagged models are OSS/open-weights |
| OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small] | 46.8% | +24.4 pp | A- system-level | all tagged models are OSS/open-weights |

Interpretation: the top OSS models are close enough for ensemble pilots.

### Top OSS-only panels by oracle headroom

| K | panel | oracle | best single | headroom | 95% CI | n | pairwise phi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] \| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] \| OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small] | 66.4% | 53.4% | +13.0 pp | [+9.5 pp, +13.8 pp] | 500 | CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B]: 0.583; CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.547; EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.601 |
| 3 | CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] \| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] \| Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8] | 66.2% | 53.4% | +12.8 pp | [+9.6 pp, +14.8 pp] | 500 | CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B]: 0.583; CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8]: 0.607; EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] / Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8]: 0.580 |
| 3 | DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] \| CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] \| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] | 70.6% | 58.8% | +11.8 pp | [+6.5 pp, +14.5 pp] | 500 | DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] / CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct]: 0.554; DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] / EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B]: 0.566; CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B]: 0.583 |
| 3 | EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] \| Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8] \| OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small] | 63.6% | 52.2% | +11.4 pp | [+8.4 pp, +13.0 pp] | 500 | EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] / Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8]: 0.580; EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.601; Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.611 |
| 3 | DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] \| CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] \| OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small] | 70.0% | 58.8% | +11.2 pp | [+6.2 pp, +13.8 pp] | 500 | DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] / CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct]: 0.554; DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.533; CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] / OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small]: 0.547 |

Interpretation: the oracle is a ceiling, not an achieved fused score; positive headroom means the members solve different tasks.

### Shortlist and lineage vetoes

| candidate | avg score | lineage | veto flags |
| --- | --- | --- | --- |
| Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] | 71.2% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] <> OpenHands + Kimi K2 [20250716_openhands_kimi_k2] (shared lineage; phi=0.707; floors met); Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] <> CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] (shared lineage; phi=0.539; floors met) |
| OpenHands + Kimi K2 [20250716_openhands_kimi_k2] | 65.4% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | OpenHands + Kimi K2 [20250716_openhands_kimi_k2] <> Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] (shared lineage; phi=0.707; floors met); OpenHands + Kimi K2 [20250716_openhands_kimi_k2] <> CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] (shared lineage; phi=0.543; floors met) |
| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B_tts] | 60.4% | base=Qwen3-Coder; teacher=none; Qwen3-Coder open-weights family | EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B_tts] <> EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] (shared lineage; phi=0.641; floors met) |
| DeepSWE-Preview + TTS(Bo16) [20250629_deepswerl_r2eagent_tts] | 58.8% | base=unknown; teacher=none; lineage uncertain | none |
| CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] | 53.4% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] <> Lingxi v1.5 x Kimi K2 [20251014_Lingxi_kimi_k2] (shared lineage; phi=0.539; floors met); CodeSweep - SWE-agent - Kimi K2 Instruct [20250804_codesweep_sweagent_kimi_k2_instruct] <> OpenHands + Kimi K2 [20250716_openhands_kimi_k2] (shared lineage; phi=0.543; floors met) |
| EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] | 52.2% | base=Qwen3-Coder; teacher=none; Qwen3-Coder open-weights family | EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B] <> EntroPO + R2E + Qwen3-Coder-30B-A3B-Instruct [20250901_entroPO_R2E_QwenCoder30BA3B_tts] (shared lineage; phi=0.641; floors met) |
| Skywork-SWE-32B + TTS(Bo8) [20250616_Skywork-SWE-32B+TTS_Bo8] | 47.0% | base=Qwen2.5-Coder; teacher=none; Qwen2.5-Coder open-weights family | none |
| OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small] | 46.8% | base=Devstral/Mistral; teacher=none; Mistral/Devstral open-weights family | none |

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## Repo bugfix system-level / SWE-bench Test experiments supplement

- Tier: A- system-level.
- This supplement is scaffold-confounded and has a much smaller post-2025 submission universe.
- Verdict: **insufficient OSS universe**; OSS universe=0 systems, common task set n=0, #1-#2 gap NA, #1-#5 spread NA.
- Closed/frontier anchor: Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5] at 52.6%.

### Field shape

No OSS systems with adequate common coverage were found.

### Top OSS-only panels by oracle headroom

No K=2/3 OSS panel survives lineage-veto constraints.

### Shortlist and lineage vetoes

No shortlist: fewer than one OSS candidate.

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## Terminal-agentic / Terminal-Bench trajectories

- Tier: A- system-level.
- Terminal-Bench is agent+model evidence with only 89 tasks, so phi floors often fail.
- Verdict: **peer-shaped**; OSS universe=20 systems, common task set n=89, #1-#2 gap +9.2 pp, #1-#5 spread +15.8 pp.
- Closed/frontier anchor: forge :: gemini-3.1-pro-preview@Google at 78.4%.

### Field shape

| model | avg score | gap to #1 | tier | OSS classification note |
| --- | --- | --- | --- | --- |
| terminus-2 :: glm-5@z-ai | 52.4% | +0.0 pp | A- system-level | all tagged models are OSS/open-weights |
| terminus-2 :: kimi-k2.5@kimi | 43.2% | +9.2 pp | A- system-level | all tagged models are OSS/open-weights |
| terminus-2 :: minimax-m2.5@Minimax | 42.2% | +10.2 pp | A- system-level | all tagged models are OSS/open-weights |
| terminus-2 :: deepseek-v3.2@deepseek | 39.6% | +12.9 pp | A- system-level | all tagged models are OSS/open-weights |
| claude-code :: minimax-m2.1@minimax | 36.6% | +15.8 pp | A- system-level | all tagged models are OSS/open-weights |
| terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai | 35.7% | +16.7 pp | A- system-level | all tagged models are OSS/open-weights |
| terminus-2 :: glm-4.7@z-ai | 33.4% | +19.0 pp | A- system-level | all tagged models are OSS/open-weights |
| claude-code :: GLM-4.7@z-ai | 33.3% | +19.2 pp | A- system-level | all tagged models are OSS/open-weights |

Interpretation: the top OSS models are close enough for ensemble pilots.

### Top OSS-only panels by oracle headroom

| K | panel | oracle | best single | headroom | 95% CI | n | pairwise phi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | claude-code :: minimax-m2.1@minimax \| terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai \| terminus-2 :: glm-4.7@z-ai | 50.1% | 36.6% | +13.5 pp | [+8.5 pp, +16.4 pp] | 89 | claude-code :: minimax-m2.1@minimax / terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai: NA; claude-code :: minimax-m2.1@minimax / terminus-2 :: glm-4.7@z-ai: NA; terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai / terminus-2 :: glm-4.7@z-ai: NA |
| 3 | claude-code :: minimax-m2.1@minimax \| terminus-2 :: glm-4.7@z-ai \| claude-code :: GLM-4.7@z-ai | 49.7% | 36.6% | +13.0 pp | [+8.3 pp, +16.6 pp] | 89 | claude-code :: minimax-m2.1@minimax / terminus-2 :: glm-4.7@z-ai: NA; claude-code :: minimax-m2.1@minimax / claude-code :: GLM-4.7@z-ai: NA; terminus-2 :: glm-4.7@z-ai / claude-code :: GLM-4.7@z-ai: NA |
| 3 | terminus-2 :: deepseek-v3.2@deepseek \| claude-code :: minimax-m2.1@minimax \| terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai | 51.7% | 39.6% | +12.1 pp | [+7.9 pp, +15.7 pp] | 89 | terminus-2 :: deepseek-v3.2@deepseek / claude-code :: minimax-m2.1@minimax: NA; terminus-2 :: deepseek-v3.2@deepseek / terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai: NA; claude-code :: minimax-m2.1@minimax / terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai: NA |
| 3 | claude-code :: minimax-m2.1@minimax \| terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai \| claude-code :: GLM-4.7@z-ai | 48.5% | 36.6% | +11.9 pp | [+7.2 pp, +14.6 pp] | 89 | claude-code :: minimax-m2.1@minimax / terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai: NA; claude-code :: minimax-m2.1@minimax / claude-code :: GLM-4.7@z-ai: NA; terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai / claude-code :: GLM-4.7@z-ai: NA |
| 3 | terminus-2 :: deepseek-v3.2@deepseek \| claude-code :: minimax-m2.1@minimax \| terminus-2 :: glm-4.7@z-ai | 51.4% | 39.6% | +11.8 pp | [+7.8 pp, +15.7 pp] | 89 | terminus-2 :: deepseek-v3.2@deepseek / claude-code :: minimax-m2.1@minimax: NA; terminus-2 :: deepseek-v3.2@deepseek / terminus-2 :: glm-4.7@z-ai: NA; claude-code :: minimax-m2.1@minimax / terminus-2 :: glm-4.7@z-ai: NA |

Interpretation: the oracle is a ceiling, not an achieved fused score; positive headroom means the members solve different tasks.

### Shortlist and lineage vetoes

| candidate | avg score | lineage | veto flags |
| --- | --- | --- | --- |
| terminus-2 :: glm-5@z-ai | 52.4% | base=unknown; teacher=none; lineage uncertain | none |
| terminus-2 :: kimi-k2.5@kimi | 43.2% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | terminus-2 :: kimi-k2.5@kimi <> terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai (shared lineage; phi=NA; floors not met n=89 marginals=51/38,57/32) |
| terminus-2 :: minimax-m2.5@Minimax | 42.2% | base=MiniMax M2; teacher=none; MiniMax M2 open-weights family | terminus-2 :: minimax-m2.5@Minimax <> claude-code :: minimax-m2.1@minimax (shared lineage; phi=NA; floors not met n=89 marginals=51/38,56/33) |
| terminus-2 :: deepseek-v3.2@deepseek | 39.6% | base=DeepSeek-V3; teacher=none; DeepSeek-V3 open-weights family | none |
| claude-code :: minimax-m2.1@minimax | 36.6% | base=MiniMax M2; teacher=none; MiniMax M2 open-weights family | claude-code :: minimax-m2.1@minimax <> terminus-2 :: minimax-m2.5@Minimax (shared lineage; phi=NA; floors not met n=89 marginals=56/33,51/38) |
| terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai | 35.7% | base=Kimi K2; teacher=none; Moonshot Kimi K2 open-weights MoE | terminus-2 :: moonshotai/Kimi-K2-Thinking@together_ai <> terminus-2 :: kimi-k2.5@kimi (shared lineage; phi=NA; floors not met n=89 marginals=57/32,51/38) |
| terminus-2 :: glm-4.7@z-ai | 33.4% | base=unknown; teacher=none; lineage uncertain | none |
| claude-code :: GLM-4.7@z-ai | 33.3% | base=unknown; teacher=none; lineage uncertain | none |

Interpretation: veto flags mark shared ancestry/teacher pairs that should not co-occupy a pilot panel unless the reported phi is low.

## What this means for the capture pilot

Pilot first: **Repo bugfix model-level / SWE-Bench Verified (LLMRouterBench)**.
Recommended 3-4 model panel seed: **deepseek-r1-0528 | deepseek-v3.1-terminus | qwen3-235b-a22b-thinking-2507 | kimi-k2-0905 (alternate)**.
Public-data oracle/headroom: oracle 45.6%, headroom +17.0 pp CI [+14.3 pp, +20.5 pp].
Frontier baseline/price anchor: **claude-opus-4.1** at 41.6%.
Rationale: repo bugfix has the strongest launch demand and this Tier A model-level slice shows large OSS-only headroom without scaffold confounding; if repo patch-and-test grading is not ready, use the LCB algorithmic panel as the fallback pilot.

## Limitations

- SWE-bench experiments and Terminal-Bench are A- evidence: agent/scaffold differences are entangled with the model.
- Terminal-Bench has only 89 tasks, so phi floors usually fail even when headroom is visible.
- LLMRouterBench public rows are model-version snapshots and may be stale relative to current hosted checkpoints.
- Lineage annotations use public/common model knowledge plus benchmark metadata; uncertain bases or teachers are explicitly marked.
- Public priors shortlist and veto only; they do not rank production panels without a same-harness capture pilot.

