# C3-R16K: C3 re-run with 16k completion budget

Follow-up to `c3_transfer_report.md`, executing the verification finding that
the original run's 4096-token completion cap truncated thinking models.
Same 60 LiveCodeBench tasks (identical ids, loaded from the frozen source
bank for paired comparability), same 5 models, `max_tokens=16384`,
`request_timeout_s=600`, concurrency 1. Phase spend: $10.62
(`c3_spend_ledger.jsonl`, phase `c3r16k_full_5model`).

## Per-model pass rates: 4k vs 16k

| Model | 4k pass@1 | 16k pass@1 | 16k Wilson 95% CI | truncated @4k | truncated @16k |
|---|---:|---:|---|---:|---:|
| gpt-5.5 | 48.3% | **80.0%** | [68.2%, 88.2%] | 26/60 | 1/60 |
| claude-sonnet-4-6 | 38.3% | 41.7% | [30.1%, 54.3%] | 17/60 | 14/60 |
| qwen3-coder | 26.7% | 30.0% | [19.9%, 42.5%] | 8/60 | 0/60 |
| deepseek-chat | 27.1% | 21.7% | [13.1%, 33.6%] | 12/59 | 6/60 |
| kimi-k2-thinking | 5.2% | 11.7% | [5.8%, 22.2%] | 51/58 | **52/60** |

## Panel metrics at 16k (task bootstrap, 1000 resamples, seed 42)

| Panel | n | best single | oracle | headroom | 95% CI |
|---|---:|---:|---:|---:|---|
| P1/P3 default (kimi, qwen3, deepseek) | 60 | 30.0% | 31.7% | +1.7pp | [+0.0, +5.0] |
| P2 top-avg (gpt-5.5, sonnet, deepseek) | 60 | 80.0% | 81.7% | +1.7pp | [+0.0, +5.0] |
| gpt-5.5 + sonnet + kimi | 60 | 80.0% | 81.7% | +1.7pp | [+0.0, +5.0] |
| gpt-5.5 + sonnet + qwen3 | 60 | 80.0% | 81.7% | +1.7pp | [+0.0, +5.0] |

## Findings

1. **The original C3 headroom PASS was substantially a truncation artifact.**
   Properly budgeted, gpt-5.5 jumps 48.3% → 80.0% (it was truncating on
   26/60 tasks at 4k). With gpt-5.5 measured correctly, every panel's
   headroom collapses to +1.7pp CI [0.0, +5.0] — below the ≥5pp pass bar.
   The 10/10 failure-dependence *sign* transfer from the original run is
   unaffected (signs were positive/correlated in both layers), but the
   quantitative complementarity evidence on this slice is gone.
2. **This slice is lopsided, and the honest routing answer is single-model.**
   gpt-5.5 beats the next model by 38.3pp — far beyond the repo's
   `LOPSIDED_SCORE_GAP` (20pp) — so fusion adds cost, not quality, for
   single-shot algorithmic tasks in this difficulty window. That is itself
   a product-grade answer of exactly the kind the capability index exists
   to produce ("when not to fuse").
3. **kimi-k2-thinking is STILL not validly measured**: 52/60 completions hit
   even the 16k cap. Its true single-shot rate needs ≥32k budget or a
   provider-side reasoning cap; the committed default panel judgment
   remains provisional to that extent. Sonnet also truncated 14/60 —
   its 41.7% is a floor, not a point estimate.
4. **No judge/capture replay was run on this bank** — with +1.7pp oracle
   headroom there is nothing meaningful for selection-style fusion to
   capture on this slice; spending on a judge replay would measure noise.
   (The original run's synthesis-beats-oracle observation remains the open,
   separately testable thread — synthesis can exceed the candidate-selection
   ceiling, which lopsidedness does not cap.)

## Caveats

- Single 60-task slice, one domain (algorithmic single-shot), contest window
  2025-02..2025-04. **Contamination risk is real**: these contests likely
  predate gpt-5.5's training cutoff, which may inflate its measured rate;
  the lopsidedness conclusion should be re-checked on a post-cutoff window
  before it hardens into routing policy.
- deepseek's 27.1% → 21.7% move is within overlapping CIs (run-to-run
  variance at n=60); do not over-read it.
- All original C3 caveats (single-shot ≠ agentic, model-version mappings)
  still apply.
