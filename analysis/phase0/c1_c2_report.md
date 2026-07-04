# Phase 0 C1/C2 complementarity analysis

## Overall verdicts

- C1 existence verdict: **PASS**. At least one 2-3 system panel clears >=5 pp headroom with phi floors: swe_verified, swe_test, llmrouterbench_livecodebench, llmrouterbench_swebench, llmrouterbench_mbpp, llmrouterbench_humaneval.
- C2 selection-value verdict: **INCONCLUSIVE**. No held-out Delta_oracle CI lower bound is > 0.

## Data summary

| Source | Tier | Systems | Tasks | Clusters | Coverage |
| --- | --- | --- | --- | --- | --- |
| SWE-bench experiments VERIFIED (system-level A-) | A- system-level | 72 | 500 | 12 | 100.0%-100.0%; median 100.0% |
| SWE-bench experiments TEST (system-level A-) | A- system-level | 6 | 2294 | 12 | 100.0%-100.0%; median 100.0% |
| Terminal-Bench trajectories (system-level A-) | A- system-level | 109 | 89 | 89 | 100.0%-100.0%; median 100.0% |
| LLMRouterBench LiveCodeBench coding subset (tier A) | A | 37 | 1055 | 1055 | 100.0%-100.0%; median 100.0% |
| LLMRouterBench SWE-Bench verified subset (tier A) | A | 14 | 500 | 12 | 100.0%-100.0%; median 100.0% |
| LLMRouterBench mbpp coding subset (tier A) | A | 20 | 974 | 974 | 99.9%-100.0%; median 100.0% |
| LLMRouterBench humaneval coding subset (tier A) | A | 22 | 164 | 164 | 100.0%-100.0%; median 100.0% |

## SWE-bench experiments VERIFIED (system-level A-)

- Official HF task list gives 500 tasks; all non-resolved instances are failures.
- Submissions restricted to IDs dated 2025-01 onward.
- Summary: 72 systems, 500 tasks, 12 clusters, tier A- system-level.

### C1 findings

Best panel: **live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview]; EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet [20250804_epam-ai-run-claude-4-sonnet]; Warp [20250901_warp]**.
Headroom: +9.0 pp CI [+6.5 pp, +12.5 pp]; oracle 86.4%; best single on common tasks 77.4%; n=500; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview] || EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet [20250804_epam-ai-run-claude-4-sonnet] | 0.666 | 500 | fail/pass A 113.0/387.0; fail/pass B 116.0/384.0 | yes |
| live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview] || Warp [20250901_warp] | 0.617 | 500 | fail/pass A 113.0/387.0; fail/pass B 122.0/378.0 | yes |
| EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet [20250804_epam-ai-run-claude-4-sonnet] || Warp [20250901_warp] | 0.603 | 500 | fail/pass A 116.0/384.0; fail/pass B 122.0/378.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview]; EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet [20250804_epam-ai-run-claude-4-sonnet]; Warp [20250901_warp] | +9.0 pp | 86.4% | 500 | live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) / EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet: 0.666; live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) / Warp: 0.617; EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet / Warp: 0.603 | yes |
| 3 | EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet [20250804_epam-ai-run-claude-4-sonnet]; ACoder [20250819_ACoder]; Warp [20250901_warp] | +9.0 pp | 85.8% | 500 | EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet / ACoder: 0.688; EPAM AI/Run Developer Agent v20250719 + Claude 4 Sonnet / Warp: 0.603; ACoder / Warp: 0.594 | yes |
| 3 | live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview]; ACoder [20250819_ACoder]; Warp [20250901_warp] | +8.8 pp | 86.2% | 500 | live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) / ACoder: 0.634; live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) / Warp: 0.617; ACoder / Warp: 0.594 | yes |
| 3 | ACoder [20250819_ACoder]; Warp [20250901_warp]; TRAE + Claude Sonnet 4 + Opus 4 + Sonnet 3.7 + Gemini 2.5 Pro [20250612_trae] | +8.4 pp | 84.8% | 500 | ACoder / Warp: 0.594; ACoder / TRAE + Claude Sonnet 4 + Opus 4 + Sonnet 3.7 + Gemini 2.5 Pro: 0.684; Warp / TRAE + Claude Sonnet 4 + Opus 4 + Sonnet 3.7 + Gemini 2.5 Pro: 0.644 | yes |
| 3 | TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]; 20251127_openhands_claude-opus-4-5 [20251127_openhands_claude-opus-4-5]; live-SWE-agent + Gemini 3 Pro Preview (2025-11-18) [20251120_livesweagent_gemini-3-pro-preview] | +8.2 pp | 87.0% | 500 | TRAE + Doubao-Seed-Code / 20251127_openhands_claude-opus-4-5: 0.602; TRAE + Doubao-Seed-Code / live-SWE-agent + Gemini 3 Pro Preview (2025-11-18): 0.621; 20251127_openhands_claude-opus-4-5 / live-SWE-agent + Gemini 3 Pro Preview (2025-11-18): 0.708 | yes |
SWE scaffold-controlled subgroup: `openhands` (8 systems) best headroom +8.4 pp CI [+4.9 pp, +9.0 pp] on n=500 for OpenHands [20250415_openhands]; OpenHands + Kimi K2 [20250716_openhands_kimi_k2]; OpenHands + DevStral Small 2505 [20250520_openhands_devstral_small].

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code] | TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]; Sonar Foundation Agent + Claude 4.5 Opus [20251205_sonar-foundation-agent_claude-opus-4-5] | -3.0 pp | [-3.7 pp, -2.1 pp] | -0.3 pp | +0.0 pp | fail |
| 3 | MCTS-Refine-7B [20250627_agentless_MCTS-Refine-7B]; JoyCode + Claude 4 Sonnet + GPT-4.1 [20250915_JoyCode]; TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code] | TRAE + Doubao-Seed-Code [20250928_trae_doubao_seed_code]; Sonar Foundation Agent + Claude 4.5 Opus [20251205_sonar-foundation-agent_claude-opus-4-5]; 20251127_openhands_claude-opus-4-5 [20251127_openhands_claude-opus-4-5] | -3.9 pp | [-5.7 pp, -1.2 pp] | -1.2 pp | +0.0 pp | fail |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## SWE-bench experiments TEST (system-level A-)

- Official HF task list gives 2294 tasks; all non-resolved instances are failures.
- Submissions restricted to IDs dated 2025-01 onward.
- Summary: 6 systems, 2294 tasks, 12 clusters, tier A- system-level.

### C1 findings

Best panel: **Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev]; SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219]**.
Headroom: +8.2 pp CI [+6.1 pp, +10.9 pp]; oracle 52.5%; best single on common tasks 44.2%; n=2294; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE] || Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev] | 0.690 | 2294 | fail/pass A 1279.0/1015.0; fail/pass B 1331.0/963.0 | yes |
| Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE] || SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219] | 0.606 | 2294 | fail/pass A 1279.0/1015.0; fail/pass B 1518.0/776.0 | yes |
| Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev] || SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219] | 0.669 | 2294 | fail/pass A 1331.0/963.0; fail/pass B 1518.0/776.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev]; SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219] | +8.2 pp | 52.5% | 2294 | Salesforce AI Research SAGE (bash-only) / Atlassian Rovo Dev (2025-06-05): 0.690; Salesforce AI Research SAGE (bash-only) / SWE-agent 1.0 (Claude 3.7 Sonnet): 0.606; Atlassian Rovo Dev (2025-06-05) / SWE-agent 1.0 (Claude 3.7 Sonnet): 0.669 | yes |
| 3 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev]; Amazon Q Developer Agent (v20250405-dev) [20250522_amazon-q-developer-agent-20250405-dev] | +8.2 pp | 52.4% | 2294 | Salesforce AI Research SAGE (bash-only) / Atlassian Rovo Dev (2025-06-05): 0.690; Salesforce AI Research SAGE (bash-only) / Amazon Q Developer Agent (v20250405-dev): 0.633; Atlassian Rovo Dev (2025-06-05) / Amazon Q Developer Agent (v20250405-dev): 0.738 | yes |
| 3 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev]; Amazon Q Developer Agent (v20241202-dev) [20250131_amazon-q-developer-agent-20241202-dev] | +7.7 pp | 52.0% | 2294 | Salesforce AI Research SAGE (bash-only) / Atlassian Rovo Dev (2025-06-05): 0.690; Salesforce AI Research SAGE (bash-only) / Amazon Q Developer Agent (v20241202-dev): 0.559; Atlassian Rovo Dev (2025-06-05) / Amazon Q Developer Agent (v20241202-dev): 0.640 | yes |
| 3 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Amazon Q Developer Agent (v20250405-dev) [20250522_amazon-q-developer-agent-20250405-dev]; SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219] | +6.9 pp | 51.1% | 2294 | Salesforce AI Research SAGE (bash-only) / Amazon Q Developer Agent (v20250405-dev): 0.633; Salesforce AI Research SAGE (bash-only) / SWE-agent 1.0 (Claude 3.7 Sonnet): 0.606; Amazon Q Developer Agent (v20250405-dev) / SWE-agent 1.0 (Claude 3.7 Sonnet): 0.748 | yes |
| 2 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev] | +6.5 pp | 50.7% | 2294 | Salesforce AI Research SAGE (bash-only) / Atlassian Rovo Dev (2025-06-05): 0.690 | yes |
SWE scaffold-controlled subgroup: `amazon-q` (2 systems), No feasible unique-base panel.

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5] | Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE] | +0.0 pp | [+0.0 pp, +0.0 pp] | +0.0 pp | +0.0 pp | inconclusive |
| 3 | SWE-agent 1.0 (Claude 3.7 Sonnet) [20250227_sweagent-claude-3-7-20250219]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5] | Sonar Foundation Agent + Claude 4.5 Opus [20251219_sonar-foundation-agent_claude-opus-4-5]; Salesforce AI Research SAGE (bash-only) [20251027_salesforce_SAGE]; Atlassian Rovo Dev (2025-06-05) [20250605_atlassian-rovo-dev] | -0.1 pp | [-0.5 pp, +1.3 pp] | -0.1 pp | +0.0 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## Terminal-Bench trajectories (system-level A-)

- Repeated trials averaged per (agent, model, task); 89 distinct tasks.
- Kept systems with >=80% task coverage, i.e. at least 72 tasks.
- Pairwise dependence is Pearson correlation over fractional failure rates.
- Summary: 109 systems, 89 tasks, 89 clusters, tier A- system-level.

### C1 findings

Best panel: **simple_codex :: gpt-5.3-codex@openai; terminus-3-3 :: gemini-3.1-pro-preview@Google; claude-code-enhanced :: claude-opus-4-6@anthropic**.
Headroom: +12.3 pp CI [+7.6 pp, +14.9 pp]; oracle 87.4%; best single on common tasks 75.1%; n=89; floor relaxed: n=89 common tasks.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| simple_codex :: gpt-5.3-codex@openai || terminus-3-3 :: gemini-3.1-pro-preview@Google | NA | 89 | fail/pass A 22.2/66.8; fail/pass B 22.4/66.6 | no |
| simple_codex :: gpt-5.3-codex@openai || claude-code-enhanced :: claude-opus-4-6@anthropic | NA | 89 | fail/pass A 22.2/66.8; fail/pass B 29.5/59.5 | no |
| terminus-3-3 :: gemini-3.1-pro-preview@Google || claude-code-enhanced :: claude-opus-4-6@anthropic | NA | 89 | fail/pass A 22.4/66.6; fail/pass B 29.5/59.5 | no |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | simple_codex :: gpt-5.3-codex@openai; terminus-3-3 :: gemini-3.1-pro-preview@Google; claude-code-enhanced :: claude-opus-4-6@anthropic | +12.3 pp | 87.4% | 89 | simple_codex :: gpt-5.3-codex@openai / terminus-3-3 :: gemini-3.1-pro-preview@Google: NA; simple_codex :: gpt-5.3-codex@openai / claude-code-enhanced :: claude-opus-4-6@anthropic: NA; terminus-3-3 :: gemini-3.1-pro-preview@Google / claude-code-enhanced :: claude-opus-4-6@anthropic: NA | no |
| 2 | mux :: gpt-5.3-codex@openai; claude-code-enhanced :: claude-opus-4-6@anthropic | +12.0 pp | 80.5% | 89 | mux :: gpt-5.3-codex@openai / claude-code-enhanced :: claude-opus-4-6@anthropic: NA | no |
| 3 | forge :: gemini-3.1-pro-preview@Google; simple_codex :: gpt-5.3-codex@openai; claude-code-enhanced :: claude-opus-4-6@anthropic | +11.8 pp | 90.2% | 89 | forge :: gemini-3.1-pro-preview@Google / simple_codex :: gpt-5.3-codex@openai: NA; forge :: gemini-3.1-pro-preview@Google / claude-code-enhanced :: claude-opus-4-6@anthropic: NA; simple_codex :: gpt-5.3-codex@openai / claude-code-enhanced :: claude-opus-4-6@anthropic: NA | no |
| 3 | forge :: gemini-3.1-pro-preview@Google; Factory Droid :: gpt-5.3-codex@openai; claude-code-enhanced :: claude-opus-4-6@anthropic | +11.7 pp | 90.1% | 89 | forge :: gemini-3.1-pro-preview@Google / Factory Droid :: gpt-5.3-codex@openai: NA; forge :: gemini-3.1-pro-preview@Google / claude-code-enhanced :: claude-opus-4-6@anthropic: NA; Factory Droid :: gpt-5.3-codex@openai / claude-code-enhanced :: claude-opus-4-6@anthropic: NA | no |
| 3 | forge :: gemini-3.1-pro-preview@Google; Factory Droid :: gpt-5.3-codex@openai; Factory Droid :: claude-opus-4-6@anthropic | +11.5 pp | 89.9% | 89 | forge :: gemini-3.1-pro-preview@Google / Factory Droid :: gpt-5.3-codex@openai: NA; forge :: gemini-3.1-pro-preview@Google / Factory Droid :: claude-opus-4-6@anthropic: NA; Factory Droid :: gpt-5.3-codex@openai / Factory Droid :: claude-opus-4-6@anthropic: NA | no |

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google | Factory Droid :: gpt-5.3-codex@openai; forge :: gemini-3.1-pro-preview@Google | -1.8 pp | [-8.0 pp, +4.9 pp] | -1.8 pp | +3.2 pp | inconclusive |
| 3 | claude-code-enhanced :: claude-opus-4-6@anthropic; final :: claude-4.5-sonnet@anthropic; forge :: gemini-3.1-pro-preview@Google | Factory Droid :: gpt-5.3-codex@openai; forge :: gemini-3.1-pro-preview@Google; terminus-3-3 :: claude-opus-4-6@anthropic | -0.3 pp | [-4.6 pp, +5.5 pp] | -0.3 pp | +1.5 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## LLMRouterBench LiveCodeBench coding subset (tier A)

- Kept model files with >=80% coverage over 1055 tasks; excluded OpenRouter router baseline.
- No contest/date field is present in records; each task is its own cluster.
- Summary: 37 systems, 1055 tasks, 1055 clusters, tier A.

### C1 findings

Best panel: **Qwen3-8B; deepseek-v3.1-terminus; kimi-k2-0905**.
Headroom: +11.3 pp CI [+9.3 pp, +12.2 pp]; oracle 79.0%; best single on common tasks 67.7%; n=1055; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| Qwen3-8B || deepseek-v3.1-terminus | 0.594 | 1055 | fail/pass A 341.0/714.0; fail/pass B 345.0/710.0 | yes |
| Qwen3-8B || kimi-k2-0905 | 0.594 | 1055 | fail/pass A 341.0/714.0; fail/pass B 345.0/710.0 | yes |
| deepseek-v3.1-terminus || kimi-k2-0905 | 0.660 | 1055 | fail/pass A 345.0/710.0; fail/pass B 345.0/710.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Qwen3-8B; deepseek-v3.1-terminus; kimi-k2-0905 | +11.3 pp | 79.0% | 1055 | Qwen3-8B / deepseek-v3.1-terminus: 0.594; Qwen3-8B / kimi-k2-0905: 0.594; deepseek-v3.1-terminus / kimi-k2-0905: 0.660 | yes |
| 3 | Qwen3-8B; kimi-k2-0905; deepseek-v3-0324 | +10.5 pp | 78.2% | 1055 | Qwen3-8B / kimi-k2-0905: 0.594; Qwen3-8B / deepseek-v3-0324: 0.628; kimi-k2-0905 / deepseek-v3-0324: 0.685 | yes |
| 2 | Qwen3-8B; deepseek-v3.1-terminus | +8.7 pp | 76.4% | 1055 | Qwen3-8B / deepseek-v3.1-terminus: 0.594 | yes |
| 2 | Qwen3-8B; kimi-k2-0905 | +8.7 pp | 76.4% | 1055 | Qwen3-8B / kimi-k2-0905: 0.594 | yes |
| 2 | Qwen3-8B; deepseek-v3-0324 | +7.7 pp | 75.4% | 1055 | Qwen3-8B / deepseek-v3-0324: 0.628 | yes |

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | deepseek-r1-0528; gpt-5 | gpt-5; gemini-2.5-pro | +0.4 pp | [-0.8 pp, +1.7 pp] | +0.4 pp | +0.0 pp | inconclusive |
| 3 | deepseek-r1-0528; gemini-2.5-pro; gpt-5 | gpt-5; gemini-2.5-pro; deepseek-r1-0528 | +0.0 pp | [+0.0 pp, +0.0 pp] | +0.0 pp | +0.0 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## LLMRouterBench SWE-Bench verified subset (tier A)

- Kept model files with >=80% coverage over 500 tasks; excluded OpenRouter router baseline.
- Cluster key is repository parsed from instance_id.
- Summary: 14 systems, 500 tasks, 12 clusters, tier A.

### C1 findings

Best panel: **claude-sonnet-4; gemini-2.5-pro; deepseek-r1-0528**.
Headroom: +17.4 pp CI [+13.7 pp, +19.2 pp]; oracle 52.0%; best single on common tasks 34.6%; n=500; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| claude-sonnet-4 || gemini-2.5-pro | 0.523 | 500 | fail/pass A 327.0/173.0; fail/pass B 327.0/173.0 | yes |
| claude-sonnet-4 || deepseek-r1-0528 | 0.368 | 500 | fail/pass A 327.0/173.0; fail/pass B 357.0/143.0 | yes |
| gemini-2.5-pro || deepseek-r1-0528 | 0.368 | 500 | fail/pass A 327.0/173.0; fail/pass B 357.0/143.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | claude-sonnet-4; gemini-2.5-pro; deepseek-r1-0528 | +17.4 pp | 52.0% | 500 | claude-sonnet-4 / gemini-2.5-pro: 0.523; claude-sonnet-4 / deepseek-r1-0528: 0.368; gemini-2.5-pro / deepseek-r1-0528: 0.368 | yes |
| 3 | glm-4.6; qwen3-235b-a22b-thinking-2507; gemini-2.5-flash | +17.2 pp | 39.0% | 500 | glm-4.6 / qwen3-235b-a22b-thinking-2507: 0.362; glm-4.6 / gemini-2.5-flash: 0.303; qwen3-235b-a22b-thinking-2507 / gemini-2.5-flash: 0.222 | yes |
| 3 | deepseek-r1-0528; deepseek-v3.1-terminus; qwen3-235b-a22b-thinking-2507 | +17.0 pp | 45.6% | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / qwen3-235b-a22b-thinking-2507: 0.306; deepseek-v3.1-terminus / qwen3-235b-a22b-thinking-2507: 0.345 | yes |
| 3 | deepseek-r1-0528; deepseek-v3.1-terminus; glm-4.6 | +16.8 pp | 45.4% | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / glm-4.6: 0.298; deepseek-v3.1-terminus / glm-4.6: 0.360 | yes |
| 3 | deepseek-r1-0528; deepseek-v3.1-terminus; kimi-k2-0905 | +16.6 pp | 45.2% | 500 | deepseek-r1-0528 / deepseek-v3.1-terminus: 0.342; deepseek-r1-0528 / kimi-k2-0905: 0.361; deepseek-v3.1-terminus / kimi-k2-0905: 0.426 | yes |

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | claude-opus-4.1; gemini-2.5-pro | claude-opus-4.1; claude-sonnet-4 | +3.0 pp | [-4.5 pp, +4.7 pp] | +3.0 pp | +0.0 pp | inconclusive |
| 3 | claude-opus-4.1; deepseek-r1-0528; gemini-2.5-pro | claude-opus-4.1; claude-sonnet-4; deepseek-r1-0528 | +3.0 pp | [-0.9 pp, +5.4 pp] | +3.0 pp | +0.0 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## LLMRouterBench mbpp coding subset (tier A)

- Kept model files with >=80% coverage over 974 tasks; excluded OpenRouter router baseline.
- No cluster metadata is present in records; each task is its own cluster.
- Summary: 20 systems, 974 tasks, 974 clusters, tier A.

### C1 findings

Best panel: **Llama-3.1-8B-Instruct; internlm3-8b-instruct; Qwen3-8B**.
Headroom: +23.1 pp CI [+20.5 pp, +24.6 pp]; oracle 83.9%; best single on common tasks 60.7%; n=973; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| Llama-3.1-8B-Instruct || internlm3-8b-instruct | 0.302 | 973 | fail/pass A 382.0/591.0; fail/pass B 384.0/589.0 | yes |
| Llama-3.1-8B-Instruct || Qwen3-8B | 0.260 | 974 | fail/pass A 383.0/591.0; fail/pass B 441.0/533.0 | yes |
| internlm3-8b-instruct || Qwen3-8B | 0.154 | 973 | fail/pass A 384.0/589.0; fail/pass B 440.0/533.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Llama-3.1-8B-Instruct; internlm3-8b-instruct; Qwen3-8B | +23.1 pp | 83.9% | 973 | Llama-3.1-8B-Instruct / internlm3-8b-instruct: 0.302; Llama-3.1-8B-Instruct / Qwen3-8B: 0.260; internlm3-8b-instruct / Qwen3-8B: 0.154 | yes |
| 3 | internlm3-8b-instruct; MiMo-7B-RL-0530; Qwen3-8B | +22.9 pp | 83.5% | 973 | internlm3-8b-instruct / MiMo-7B-RL-0530: 0.260; internlm3-8b-instruct / Qwen3-8B: 0.154; MiMo-7B-RL-0530 / Qwen3-8B: 0.306 | yes |
| 3 | Llama-3.1-Nemotron-Nano-8B-v1; Llama-3.1-8B-Instruct; internlm3-8b-instruct | +22.5 pp | 84.1% | 973 | Llama-3.1-Nemotron-Nano-8B-v1 / Llama-3.1-8B-Instruct: 0.413; Llama-3.1-Nemotron-Nano-8B-v1 / internlm3-8b-instruct: 0.239; Llama-3.1-8B-Instruct / internlm3-8b-instruct: 0.302 | yes |
| 3 | Llama-3.1-Nemotron-Nano-8B-v1; internlm3-8b-instruct; Qwen3-8B | +22.2 pp | 83.8% | 973 | Llama-3.1-Nemotron-Nano-8B-v1 / internlm3-8b-instruct: 0.239; Llama-3.1-Nemotron-Nano-8B-v1 / Qwen3-8B: 0.348; internlm3-8b-instruct / Qwen3-8B: 0.154 | yes |
| 3 | gemma-2-9b-it; internlm3-8b-instruct; Qwen3-8B | +22.0 pp | 84.5% | 973 | gemma-2-9b-it / internlm3-8b-instruct: 0.334; gemma-2-9b-it / Qwen3-8B: 0.257; internlm3-8b-instruct / Qwen3-8B: 0.154 | yes |

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | Qwen2.5-Coder-7B-Instruct; Qwen3-8B | Qwen2.5-Coder-7B-Instruct; Fin-R1 | +0.4 pp | [-1.4 pp, +2.3 pp] | +0.4 pp | +0.0 pp | inconclusive |
| 3 | Qwen2.5-Coder-7B-Instruct; Qwen3-8B; internlm3-8b-instruct | Qwen2.5-Coder-7B-Instruct; Fin-R1; GLM-Z1-9B-0414 | +1.2 pp | [-1.2 pp, +3.7 pp] | +1.2 pp | +0.0 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## LLMRouterBench humaneval coding subset (tier A)

- Kept model files with >=80% coverage over 164 tasks; excluded OpenRouter router baseline.
- No cluster metadata is present in records; each task is its own cluster.
- Summary: 22 systems, 164 tasks, 164 clusters, tier A.

### C1 findings

Best panel: **internlm3-8b-instruct; gemma-2-9b-it; Qwen3-8B**.
Headroom: +23.8 pp CI [+17.1 pp, +27.4 pp]; oracle 89.6%; best single on common tasks 65.9%; n=164; floors met.

| Pair | phi / loss corr | n | marginals | floors |
| --- | --- | --- | --- | --- |
| internlm3-8b-instruct || gemma-2-9b-it | 0.301 | 164 | fail/pass A 56.0/108.0; fail/pass B 58.0/106.0 | yes |
| internlm3-8b-instruct || Qwen3-8B | 0.261 | 164 | fail/pass A 56.0/108.0; fail/pass B 62.0/102.0 | yes |
| gemma-2-9b-it || Qwen3-8B | 0.239 | 164 | fail/pass A 58.0/106.0; fail/pass B 62.0/102.0 | yes |

Top panels by headroom:

| K | Panel | Headroom | Oracle | n | phi / loss corr | phi floors |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | internlm3-8b-instruct; gemma-2-9b-it; Qwen3-8B | +23.8 pp | 89.6% | 164 | internlm3-8b-instruct / gemma-2-9b-it: 0.301; internlm3-8b-instruct / Qwen3-8B: 0.261; gemma-2-9b-it / Qwen3-8B: 0.239 | yes |
| 3 | internlm3-8b-instruct; gemma-2-9b-it; Llama-3.1-Nemotron-Nano-8B-v1 | +23.2 pp | 89.0% | 164 | internlm3-8b-instruct / gemma-2-9b-it: 0.301; internlm3-8b-instruct / Llama-3.1-Nemotron-Nano-8B-v1: 0.191; gemma-2-9b-it / Llama-3.1-Nemotron-Nano-8B-v1: 0.222 | yes |
| 3 | internlm3-8b-instruct; Llama-3.1-Nemotron-Nano-8B-v1; Qwen3-8B | +20.7 pp | 86.6% | 164 | internlm3-8b-instruct / Llama-3.1-Nemotron-Nano-8B-v1: 0.191; internlm3-8b-instruct / Qwen3-8B: 0.261; Llama-3.1-Nemotron-Nano-8B-v1 / Qwen3-8B: 0.467 | yes |
| 3 | gemma-2-9b-it; Llama-3.1-Nemotron-Nano-8B-v1; Qwen3-8B | +20.7 pp | 85.4% | 164 | gemma-2-9b-it / Llama-3.1-Nemotron-Nano-8B-v1: 0.222; gemma-2-9b-it / Qwen3-8B: 0.239; Llama-3.1-Nemotron-Nano-8B-v1 / Qwen3-8B: 0.467 | yes |
| 3 | cogito-v1-preview-llama-8B; internlm3-8b-instruct; Qwen3-8B | +18.9 pp | 88.4% | 164 | cogito-v1-preview-llama-8B / internlm3-8b-instruct: 0.361; cogito-v1-preview-llama-8B / Qwen3-8B: 0.276; internlm3-8b-instruct / Qwen3-8B: 0.261 | yes |

### C2 findings

| K | Complementarity panel | Top-K baseline | Held-out Delta_oracle | 95% CI | Delta_headroom | Greedy gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | Fin-R1; gpt-4.1 | gpt-4.1; Qwen2.5-Coder-7B-Instruct | -1.2 pp | [-6.1 pp, +3.7 pp] | -1.2 pp | +0.0 pp | inconclusive |
| 3 | Fin-R1; GLM-Z1-9B-0414; gpt-4.1 | gpt-4.1; Qwen2.5-Coder-7B-Instruct; Fin-R1 | -1.2 pp | [-6.1 pp, +2.4 pp] | -1.2 pp | +0.0 pp | inconclusive |
Sanity guards: no selected panel contains duplicate base engines; clustered split leakage is false for every K.

## What this means for C3

For the algorithmic domain, the public data points to the LLMRouterBench LiveCodeBench complementarity-selected panel as the best C3 seed, but C3 must run it under FusionKit's own harness before production use. Among runnable providers in this environment, use OpenAI GPT-5/GPT-5.5 class, Anthropic Claude Sonnet/Opus class, and OpenRouter-hosted Kimi K2 / Qwen3 / DeepSeek candidates. Gemini-scored public rows are useful evidence but Gemini is not runnable here, so do not include Gemini in the C3 run panel.

Recommended runnable C3 algorithmic seed panel: `gpt-5.5` or `gpt-5`, `claude-sonnet-4.x` or `claude-opus-4.x`, and `moonshotai/kimi-k2-thinking` or `deepseek/deepseek-chat` through OpenRouter. Keep `qwen/qwen3-coder` as the first alternate if the OpenRouter Kimi/DeepSeek run is unavailable or cost-constrained.

## Deviations and limitations

- LLMRouterBench is packaged as one 1.28 GB archive; the analysis downloaded it to gitignored cache and extracted only `livecodebench`, `swe-bench`, `mbpp`, and `humaneval`.
- LLMRouterBench LiveCodeBench, MBPP, and HumanEval records do not expose contest/date clusters, so each task is its own cluster as preregistered.
- SWE-bench experiments and Terminal-Bench are A- scaffold-confounded; every derived number from them is system-level.
- Terminal-Bench uses fractional averaged repeated trials, so pairwise dependence is reported as loss correlation with the same n/marginal floors.
- Public priors remain Layer-1 evidence; C3 is still required to test transfer to FusionKit's calibrated harness.
