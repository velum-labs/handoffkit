# Round 2A' preregistration: frozen-winner confirmation on a fresh slice

Frozen before any billed 2A' run. Governing docs: `../2c/report.md`
(winner selection), `../autopsy/report.md`, the arm preregistration.

## Question

On a fresh, disjoint, repo-stratified 30-instance slice, with the frozen
2C winner configuration (v2-strict-commit): does the fused N=2 k=1 system
resolve at least as many instances as its best member, and what are the
fused-only-solve and best-member-loss rates at n=30?

## Frozen configuration

- Fused row: `../2c/configs/v2-strict-commit.yaml` **unchanged** (panel
  terminus+qwen3, judge/synth=terminus, strict-commit synthesizer prompt),
  routed through the logging proxy for process metrics.
- Solo rows: terminus and qwen3 direct via OpenRouter, mini stock config,
  litellm price registry pinned — identical to round 1.
- Scaffold/grading: mini-SWE-agent v2 stock; official harness, local.

## Slice (frozen)

30 instances in `instance_manifest.txt`: drawn seed-43 from the 489
non-dev instances with a 12-per-repo cap (round 1 was 60% django);
selection rule + universe hash in the manifest header. Dev instances and
the smoke instance are excluded by construction.

## Read-outs (recomputed from official reports)

1. Per-row resolved counts, Wilson 95% CIs.
2. Fused vs best solo (primary), solo oracle + capture (lower frame).
3. **Fused-only-solve rate**: P(fused resolves | neither member resolves) —
   the composition-value estimate the round-1 n=1 observation motivated.
4. **Best-member-loss rate**: P(fused fails | best member resolves).
5. Process metrics for the fused row (null rate, verbatim compliance) at
   n=30 scale.

No gate: this is the honest measurement the arm exists to produce. Public
claims still require the full task set (plan Step-5 rule).

## Execution

`run_2a.sh --phase solo|fused|grade|all --confirm`; solos first with the
$12 checkpoint, fresh output dirs, PID-file teardown (zombie rule).

## Spend

Cap: **$40** total for 2A' (30 instances: solos ~$1.5-4.5 each by
round-1 scaling; fused ~3-4x). Abort checkpoint after solos at $12.

## Deviations

None at preregistration time.
