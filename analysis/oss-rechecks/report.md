# OSS-only rechecks report

Preregistration: `preregistration.md` (frozen before running). No billed API
calls; both rechecks are reanalyses of committed artifacts and cached public
snapshots. All numbers below were recomputed from the output CSVs.

## Recheck 1 — OSS-only C2 + C2V selection value

Universes filtered to `is_oss=True` systems from the committed
`analysis/oss-scan/oss_classification.csv`. `swe_test` skipped (0 OSS
systems). 5 domains × K∈{2,3} = 10 cases per objective.

### C2 objective (train oracle selection) — `c2_oss_results.csv`

| Source | K | OSS systems | Held-out Delta_oracle | 95% CI | Status |
| --- | --- | ---: | ---: | --- | --- |
| llmrouterbench_livecodebench | 2 | 31 | -1.5 pp | [-3.0, +0.0] | inconclusive |
| llmrouterbench_livecodebench | 3 | 31 | -1.3 pp | [-2.5, -0.2] | **fail** |
| mbpp_humaneval | 2 | 20 | -0.5 pp | [-2.5, +1.2] | inconclusive |
| mbpp_humaneval | 3 | 20 | +2.6 pp | [+0.5, +4.7] | **pass** |
| llmrouterbench_swebench | 2 | 8 | +0.0 pp | [+0.0, +0.0] | identical panels |
| llmrouterbench_swebench | 3 | 8 | -0.3 pp | [-1.7, +4.3] | inconclusive |
| swe_verified | 2 | 15 | -1.2 pp | [-11.4, +0.7] | inconclusive |
| swe_verified | 3 | 15 | -0.9 pp | [-8.5, +0.3] | inconclusive |
| terminalbench | 2 | 20 | -1.2 pp | [-4.6, +1.3] | inconclusive |
| terminalbench | 3 | 20 | -2.1 pp | [-5.3, +0.0] | inconclusive |

### C2V objective (V = best_single + 0.7·headroom) — `c2v_oss_results.csv`

Same split and universes. Result pattern is identical: **1 pass**
(mbpp_humaneval K=3, +1.8 pp CI [+0.4, +3.3]), **1 fail**
(llmrouterbench_livecodebench K=3), 8 inconclusive/identical. Capture
sensitivity at 0.5/0.9 changed no selected panel.

### Interpretation

- **The C2 conclusion survives OSS-only restriction where it matters.** On
  the product-relevant domains (repo bugfix, algorithmic, terminal), no
  OSS-only selection case produced a held-out win; algorithmic K=3 is an
  outright loss, exactly as in the mixed-universe C2.
- **One technical pass exists, on the least product-relevant domain.** Under
  the inherited preregistered rule ("CI lower bound > 0 for some source×K"),
  mbpp_humaneval K=3 passes under both objectives: complementarity-aware
  selection picked `Qwen2.5-Coder-7B + Qwen3-8B + internlm3-8b` over the
  baseline's `Qwen2.5-Coder-7B + Fin-R1 + glm-4-9b` and won ~+2.6 pp oracle
  out of sample. Honest caveats: this is 1 win in 10 cases per objective
  (multiple comparisons), on the saturated, low-demand MBPP/HumanEval slice
  among small 7-9B models, and it did not replicate on any other domain.
- **D2 stands unchanged**: public data shortlists and vetoes; final OSS panel
  membership still requires calibration runs. The mbpp result is not strong
  enough to overturn a twice-settled negative on the domains we would launch.
- **Reassuring detail for D10:** on repo bugfix model-level (K=2), the
  complementarity objective and the top-K baseline select the *same* panel —
  `deepseek-r1-0528 + deepseek-v3.1-terminus` — i.e. the D10 seed pair is
  robust to selection objective.

## Recheck 2 — OSS-only C3 sign transfer

Pairs among OSS calibrated endpoints (deepseek-chat, kimi-k2-thinking,
qwen3-coder), recomputed from `analysis/phase0/c3_outcomes.csv` and cached
public LiveCodeBench records — `c3_sign_oss.csv`:

| Pair | public phi/sign | calibrated phi/sign | agreement |
| --- | --- | --- | --- |
| deepseek / kimi | 0.660 / positive | 0.394 / positive | yes |
| deepseek / qwen3 | 0.594 / positive | 0.571 / positive | yes |
| kimi / qwen3 | 0.594 / positive | 0.378 / positive | yes |

**OSS-only sign agreement: 3/3.** The shortlist/veto use of public phi holds
on the OSS-only slice (algorithmic domain, one round — same caveats as the
original C3 result).

## Verdicts

- OSS-only C2/C2V: **conclusion upheld** on product-relevant domains; one
  isolated mbpp_humaneval K=3 pass recorded for completeness, insufficient to
  change D2.
- OSS-only sign transfer: **3/3 agreement** — veto/shortlist usage unchanged.

## Deviations from preregistration

None.
