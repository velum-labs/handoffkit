# Round 2C preregistration: aggregation variants on the dev slice

Frozen before billed 2C rows. Governing docs:
`../autopsy/report.md` (evidence), `docs/fusion/k1-official-harness-plan-2026-07.md`.

## Question

Which aggregation fix moves the pipeline's **process metrics** — judge
abstention rate, synthesizer verbatim compliance on contested steps, judge
truncated-evidence complaints — on the fixed panel and fixed dev slice?

## Design

- Slice: the 10 round-1 manifest instances (`../instance_manifest.txt`) —
  the **dev set**. Resolve counts are recorded but explicitly
  noise-dominated at n=10; selection is by process metrics (step-level,
  n in the hundreds). Outcome confirmation is round 2A' on a fresh slice.
- Panel/judge/scaffold/grading: identical to round 1 (terminus + qwen3,
  judge=terminus, mini-SWE-agent v2 stock, official harness). All rows
  route through the logging proxy for full call capture.
- Rows (one axis each; `configs/`):
  - **v0-baseline**: round-1 config, proxied. Re-measures baseline process
    metrics at dev-slice scale (autopsy baseline was 3 instances).
  - **v1-wide-evidence**: endpoints declare true `max_context` (163840 /
    1048576). Mechanism: judge/synth evidence packing budgeted against
    reality instead of `ContextPolicy.default_max_context=64k`.
  - **v2-strict-commit**: synthesizer prompt override demanding byte-exact
    adoption of exactly one candidate (the judge's pick when present).
  - **v3-judge-discipline**: judge prompt override — hard never-null rule
    plus ordered decision factors (mechanism correctness, verification
    coverage, regression risk).

## Metrics (from proxy captures via `analyze_autopsy.py`, plus grading)

Per row: judge null rate; verbatim-adoption rate on contested steps;
judge-cites-truncation rate (regex over judge analyses); steps/instance;
resolved count (context only). Baselines from the autopsy: null 41%,
verbatim-on-contested 19/83, truncation complaints frequent.

## Selection rule (pre-registered)

The winner is the variant (or minimal combination, tested only if two
variants each move their own metric without hurting the others') with the
largest improvement in its targeted process metric and no degradation
> 10 points in the other two. If no variant moves its metric, 2C reports
null and 2A' runs the baseline config.

## Spend

Cap: $15 for round 2C (expect ~$2-3/row x 4 rows). Dev-slice reruns are
fresh rolls; no per-instance claims.

## Deviations

None at preregistration time.
