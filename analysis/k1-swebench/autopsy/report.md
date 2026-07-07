# Judge autopsy report (round 2B)

Preregistration: `preregistration.md`. Capture: 674 provider calls through
the logging proxy (`/tmp` raw, 43MB, not committed); reconstructed steps
committed as `steps_full.json` (169 steps across the 3 instances).
Analyzer: `../scripts/analyze_autopsy.py`.

## Rerun outcomes (fresh rolls, official harness grading)

| instance | round 1 fused | autopsy rerun |
|---|---|---|
| astropy__astropy-14508 | target fixed, 1 regression (unresolved) | unresolved |
| django__django-12125 | **resolved (fused-only)** | unresolved |
| pylint-dev__pylint-7080 | unresolved (qwen3-identical patch) | unresolved |

**Finding 0 — outcome variance is high.** The round-1 fused-only win did
not reproduce; in the rerun both members converged on the same shallow
pylint mechanism that round-1's qwen3 took (the wrong mechanism is an
attractor, not a qwen3 quirk). Any per-instance claim at these settings is
a coin with unknown bias; only rates over instances are meaningful.

## The pre-registered question — near-tie or confident?

Mostly **neither**: the dominant failure modes sit in the commit pipeline
around the judge, not in marginal judgment quality.

1. **The judge abstains on 41% of steps** (69/169 `best_trajectory: null`)
   despite the step prompt's "never null for a tie." On abstained steps
   the synthesizer composes freely.
2. **The synthesizer does not follow the contract on contested steps.** Of
   83 steps where members proposed materially different batches AND the
   judge named a pick: verbatim adoption **19**, light rewrite of one
   candidate **52**, adopted the *other* member **12**. The rewrites are
   usually small (extra grep flags, tweaked heredoc) but they are exactly
   the "never rewrite arguments" violations the step prompts forbid — and
   they make the committed path nobody's path.
3. **The judge is judging truncated evidence — mechanistic root cause
   found.** Its analyses repeatedly say the candidates' patches are
   "truncated, making it impossible to evaluate fully": the decisive
   steps (heredoc patch writes) exceed the evidence packing budget.
   Cause: `ContextPolicy.default_max_context = 64_000` applies because
   the panel endpoints declare no `max_context` — the judge packs
   evidence to 64k while terminus actually has 163k and qwen3 1M. A
   pure-config fix (declare real `max_context`) widens the judge's
   evidence ~2.5x.
4. **Self-inconsistent picks.** e.g. pylint step 39: the judge's own
   `likely_errors` says "Terminus jumps to modification without
   sufficient analysis" — and names terminus best in the same verdict.
   Verification-coverage pressure exists nowhere in the contract.

## What this licenses (round 2C variants, one axis each)

- **V1 wide-evidence (mechanistic):** declare true `max_context` per
  endpoint. Process metric: judge stops citing truncated patches; null
  rate expected to drop.
- **V2 strict-commit:** synthesizer prompt override demanding byte-exact
  adoption of exactly one named candidate. Process metric: verbatim rate
  on contested steps (19/83 baseline).
- **V3 judge-discipline:** judge prompt override — reassert never-null,
  and require the verdict to weigh verification coverage and regression
  risk. Process metrics: null rate (41% baseline), pick/self-criticism
  consistency.

Variant selection on the dev slice weights **process metrics** (they are
step-level, hence high-n and low-variance) over resolve counts (n=10,
noise-dominated); outcome confirmation belongs to round 2A' on a fresh
slice.

## Spend

Rerun ~$1 (3 instances, sequential); grading local/unbilled.
