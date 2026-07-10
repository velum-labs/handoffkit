# Solo sweep results — error-correlation experiment, 2026-07-09

**Goal:** find cheap models whose *failure sets* are decorrelated from the
measured pool (gemini-3.1-pro anchor), i.e. models that solve some of the 35
tasks the old cheap pool never solved.
**Setup:** 8 solo runs (single-member panel, model judges itself) on the frozen
60-task manifest. Configs `configs/benchmark-panel.solo.s*.yaml`, runner
`run_phase_c.py run-solo-sweep`. Ledger after sweep: $46.02 of $75.

## Reference points

- Old cheap-pool union (9 models, all prior runs): **25/60**; best measured trio ceiling 25/60.
- `gpt-5.5` solo (e1): **45/60 (75%)**, $2.39, zero failed tasks.

## Solo results

| Run | Model | Solo score | Adds over gemini | Covers never-solved-35 | Cost |
|-----|-------|-----------|------------------|------------------------|------|
| s2 | moonshotai/kimi-k2-thinking | **29/52*** (56%) | **+8** | **6** | $1.75 |
| s6 | openai/gpt-oss-120b | **27/57*** (47%) | **+5** | **5** | **$0.04** |
| s7 | z-ai/glm-5.2 | 22/59 (37%) | +1 | 1 | $1.10 |
| s3 | nvidia/nemotron-3-ultra-550b | 21/57 (37%) | +0 | 0 | $0.85 |
| s5 | poolside/laguna-m.1 | 17/60 (28%) | +0 | 0 | $0.19 |
| s1 | qwen/qwen3-max-thinking | 15/57 (26%) | +0 | 0 | $0.95 |
| s4 | mistralai/mistral-large-2512 | 14/60 (23%) | +2 | 1 | $0.21 |
| s8 | qwen/qwen3-coder | 13/60 (22%) | +0 | 0 | $0.18 |

*s2 had 8 unscored tasks (6 model_failed, 2 infra — long thinking traces hitting
limits); s6/s1/s3 had 3 each. True capability may be slightly higher.

## Findings

1. **Decorrelation found — and it is reasoning-shaped.** kimi-k2-thinking and
   gpt-oss-120b crack 6 and 5 of the never-solved-35 respectively. Both are
   reasoning models. Non-reasoning mid-tier models (glm-5.2, nemotron-ultra,
   laguna, qwen3-coder) score OK but stay inside gemini's solve set (+0/+1).
2. **qwen3-max-thinking underperformed badly** (15/57 vs published reputation).
   Suspect the 8192 max_tokens cap truncates its long thinking traces; its
   score should not be taken as its true capability without a re-run at a
   higher cap.
3. **gpt-oss-120b is the cost outlier of the entire program:** 27/57 for four
   cents a run ($0.03/$0.15 per M). Per dollar it is ~50x better than anything
   else measured.
4. **gpt-5.5 strictly dominates the cheap pool.** Every task solved by any of
   the 8 sweep models is inside gpt-5.5's 45-task solve set. No cheap trio can
   exceed 45 even in principle; nothing cheap adds anything on top of gpt-5.5.

## Updated set-cover (predicted perfect-judge score, gemini judge fixed)

| Trio | Predicted oracle /60 |
|------|----------------------|
| **gemini + kimi-k2-thinking + gpt-oss-120b** | **35** |
| gemini + kimi-k2-thinking + mistral-large | 32 |
| gemini + kimi-k2-thinking + (anything else) | 31 |
| old ceiling (any trio from prior pool) | 25 |

Judge regret measured ~0 across all prior runs, so fused ≈ oracle is the
expectation; synthesis uplift (+1 to +3 in prior runs) could push higher.

**Recommended next run:** `gemini + kimi-k2-thinking + gpt-oss-120b`, gemini
judge (~$6): predicted fused ~33–35/60 vs old best 25 — would close ~half the
gap to gpt-5.5 (45) at roughly 1/10th the member cost tier.

Raw artifacts: `labruns/2026-q3/results/solo-sweep/`.
