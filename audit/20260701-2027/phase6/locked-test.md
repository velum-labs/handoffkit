# Public Benchmark Comparison: LiveCodeBench

Disclaimer: external public-benchmark comparison; fusion numbers are measured from this run, while baseline numbers are cited from public leaderboards and may use a different harness version or date.

## Could fusion win at all?

- Panel: decorrelated-peers (mount mode: fusion_behind_agent)
- Best single member: - (-)
- Oracle ceiling (independent failures): -
- Oracle headroom over best single: -
- Lopsided panel: no
- no published member scores available for this suite

### Measured failure correlation (lower = more diverse, more headroom)

| Left | Right | N | Correlation |
| --- | --- | ---: | ---: |
| gpt | opus | 86 | 0.5586 |

## Fusion result

- Availability: ran
- Fusion score: 0.6628 (57/86 scored tasks)
- 95% CI (Wilson): [0.5578, 0.7538]
- Best single member (within run): -
- Measured oracle (this run): 0.6628
- Measured judge regret (oracle - fusion): 0.0000
- Fusion cost per task: $0.29
- Task accounting: scored=86 model_failed=0 infra_error=0 excluded=0

## Published leaderboard (context only)

_published leaderboard numbers are CONTEXT ONLY - they use a different harness version, model set, and (here) a different task subset, so they are not a like-for-like comparison; trust the within-run metrics above._

| Model | Score | Cost/run | Delta vs fusion | Contam-controlled | As of |
| --- | ---: | ---: | ---: | :--: | --- |
| deepseek-v4-pro | 0.9350 | - | -0.2722 | yes | 2026-06 |
| gpt-5.3-codex | 0.7120 | - | -0.0492 | yes | 2026-06 |
| claude-opus-4.6 | 0.6810 | - | -0.0182 | yes | 2026-06 |
