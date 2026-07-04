# C2V V-selection re-test

## Overall verdict

**INCONCLUSIVE** by the preregistered rule.

V-selection agreed exactly with the top-K baseline in 2/14 source×K cases.

## Per-source results

| Source | K | V-selected panel | Top-K baseline | Identical | Held-out Delta_V | 95% CI | Delta_oracle | Delta_best_single | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| swe_verified | 2 | JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code] | TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]; Sonar Foundation Agent + Claude 4.5 Opus [20251205_sonar-foundation-agent_claude-opus-4-5] | no | -2.9 pp | [-3.9 pp, -1.5 pp] | -3.0 pp | -2.7 pp | fail |
| swe_verified | 3 | MCTS-Refine-7B [20250627_agentless_MCTS-Refine-7B]; JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code] | TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]; Sonar Foundation Agent + Claude 4.5 Opus [20251205_sonar-foundation-agent_claude-opus-4-5]; 20251127_openhands_claude-opus-4-5 [20251127_openhands_claude-opus-4-5] | no | -3.5 pp | [-4.9 pp, -0.9 pp] | -3.9 pp | -2.7 pp | fail |
| swe_test | 2 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5] | Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE] | yes | +0.0 pp | [+0.0 pp, +0.0 pp] | +0.0 pp | +0.0 pp | selection agrees with baseline |
| swe_test | 3 | SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5] | Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev] | no | -0.1 pp | [-0.3 pp, +0.9 pp] | -0.1 pp | +0.0 pp | inconclusive |
| terminalbench | 2 | final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google | Factory Droid :: gpt-5.3-codex@openai; forge :: gemini-3.1-pro-preview@Google | no | -1.2 pp | [-6.5 pp, +3.4 pp] | -1.8 pp | +0.0 pp | inconclusive |
| terminalbench | 3 | claude-code-enhanced :: claude-opus-4-6@anthropic; final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google | Factory Droid :: gpt-5.3-codex@openai; forge :: gemini-3.1-pro-preview@Google; terminus-3-3 :: claude-opus-4-6@anthropic | no | -0.2 pp | [-4.6 pp, +3.7 pp] | -0.3 pp | +0.0 pp | inconclusive |
| llmrouterbench_livecodebench | 2 | deepseek-r1-0528; gpt-5 | gpt-5; gemini-2.5-pro | no | +0.3 pp | [-0.5 pp, +1.2 pp] | +0.4 pp | +0.0 pp | inconclusive |
| llmrouterbench_livecodebench | 3 | deepseek-r1-0528; gemini-2.5-pro; gpt-5 | gpt-5; gemini-2.5-pro; deepseek-r1-0528 | yes | +0.0 pp | [+0.0 pp, +0.0 pp] | +0.0 pp | +0.0 pp | selection agrees with baseline |
| llmrouterbench_swebench | 2 | claude-opus-4.1; gemini-2.5-pro | claude-opus-4.1; claude-sonnet-4 | no | +2.1 pp | [-4.1 pp, +3.3 pp] | +3.0 pp | +0.0 pp | inconclusive |
| llmrouterbench_swebench | 3 | claude-opus-4.1; deepseek-r1-0528; gemini-2.5-pro | claude-opus-4.1; claude-sonnet-4; deepseek-r1-0528 | no | +2.1 pp | [-1.6 pp, +3.8 pp] | +3.0 pp | +0.0 pp | inconclusive |
| llmrouterbench_mbpp | 2 | Qwen2.5-Coder-7B-Instruct; Qwen3-8B | Qwen2.5-Coder-7B-Instruct; Fin-R1 | no | +0.3 pp | [-1.0 pp, +1.6 pp] | +0.4 pp | +0.0 pp | inconclusive |
| llmrouterbench_mbpp | 3 | Qwen2.5-Coder-7B-Instruct; Qwen3-8B; internlm3-8b-instruct | Qwen2.5-Coder-7B-Instruct; Fin-R1; GLM-Z1-9B-0414 | no | +0.9 pp | [-0.9 pp, +2.6 pp] | +1.2 pp | +0.0 pp | inconclusive |
| llmrouterbench_humaneval | 2 | Fin-R1; gpt-4.1 | gpt-4.1; Qwen2.5-Coder-7B-Instruct | no | -0.9 pp | [-4.3 pp, +2.6 pp] | -1.2 pp | +0.0 pp | inconclusive |
| llmrouterbench_humaneval | 3 | Fin-R1; GLM-Z1-9B-0414; gpt-4.1 | gpt-4.1; Qwen2.5-Coder-7B-Instruct; Fin-R1 | no | -0.9 pp | [-4.3 pp, +1.7 pp] | -1.2 pp | +0.0 pp | inconclusive |

## Capture sensitivity

| Source | K | Sensitivity result |
| --- | --- | --- |
| swe_verified | 2 | capture=0.5: same (JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]); capture=0.9: same (JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]) |
| swe_verified | 3 | capture=0.5: same (MCTS-Refine-7B [20250627_agentless_MCTS-Refine-7B]; JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]); capture=0.9: same (MCTS-Refine-7B [20250627_agentless_MCTS-Refine-7B]; JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]) |
| swe_test | 2 | capture=0.5: same (Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]); capture=0.9: same (Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]) |
| swe_test | 3 | capture=0.5: same (SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]); capture=0.9: same (SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]) |
| terminalbench | 2 | capture=0.5: same (final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google); capture=0.9: same (final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google) |
| terminalbench | 3 | capture=0.5: same (claude-code-enhanced :: claude-opus-4-6@anthropic; final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google); capture=0.9: same (claude-code-enhanced :: claude-opus-4-6@anthropic; final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google) |
| llmrouterbench_livecodebench | 2 | capture=0.5: same (deepseek-r1-0528; gpt-5); capture=0.9: same (deepseek-r1-0528; gpt-5) |
| llmrouterbench_livecodebench | 3 | capture=0.5: same (deepseek-r1-0528; gemini-2.5-pro; gpt-5); capture=0.9: same (deepseek-r1-0528; gemini-2.5-pro; gpt-5) |
| llmrouterbench_swebench | 2 | capture=0.5: same (claude-opus-4.1; gemini-2.5-pro); capture=0.9: same (claude-opus-4.1; gemini-2.5-pro) |
| llmrouterbench_swebench | 3 | capture=0.5: same (claude-opus-4.1; deepseek-r1-0528; gemini-2.5-pro); capture=0.9: same (claude-opus-4.1; deepseek-r1-0528; gemini-2.5-pro) |
| llmrouterbench_mbpp | 2 | capture=0.5: same (Qwen2.5-Coder-7B-Instruct; Qwen3-8B); capture=0.9: same (Qwen2.5-Coder-7B-Instruct; Qwen3-8B) |
| llmrouterbench_mbpp | 3 | capture=0.5: same (Qwen2.5-Coder-7B-Instruct; Qwen3-8B; internlm3-8b-instruct); capture=0.9: same (Qwen2.5-Coder-7B-Instruct; Qwen3-8B; internlm3-8b-instruct) |
| llmrouterbench_humaneval | 2 | capture=0.5: same (Fin-R1; gpt-4.1); capture=0.9: same (Fin-R1; gpt-4.1) |
| llmrouterbench_humaneval | 3 | capture=0.5: same (Fin-R1; GLM-Z1-9B-0414; gpt-4.1); capture=0.9: same (Fin-R1; GLM-Z1-9B-0414; gpt-4.1) |

## Interpretation vs original C2

V-selection did not produce a statistically positive held-out Delta_V over the top-K baseline in this run.
Unlike pure oracle selection, V-selection still loses outright in swe_verified K=2, swe_verified K=3.
Identical-panel cases are informative ties: the V objective prefers the same strong systems as the average-score baseline rather than weak decorrelated systems.

## Sanity guards

- Source system counts matched the original C2 report/preregistration counts.
- No selected V or baseline panel contains duplicate base engines.
- Clustered split leakage was false for every source and K.
- No billed API calls were made.

## Limitations and deviations

- The analysis uses the same public Layer-1 rows as original C2; A- sources remain scaffold-confounded and system-level.
- Terminal-Bench rows are loaded from the public HF parquet endpoint, as in the working C1/C2 loader.
- The original C2 preregistration's recorded base-engine parser correction is inherited from the working analysis script.
- No deviations from the C2V preregistered objective, split, baseline, bootstrap, or pass/fail rule.
