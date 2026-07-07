# Round 2C report: aggregation variants on the dev slice

Preregistration: `preregistration.md`. All rows: fixed panel
(terminus+qwen3, judge=terminus), fixed 10-instance dev slice, mini-SWE-agent
v2 stock, official harness grading, full provider-call capture via the
logging proxy. Process metrics recomputed from captures by
`../scripts/analyze_autopsy.py`; resolve counts from official reports.

## Results

| row | steps | judge null rate | verbatim-followed (contested) | judge truncation complaints | resolved (context) |
|---|---|---|---|---|---|
| v0-baseline | 655 | 54.2% | 59/267 (22.1%) | 11.1% | 5/10 |
| v1-wide-evidence | 577 | 62.4% | 32/187 (17.1%) | 10.4% | 5/10 |
| v2-strict-commit | 542 | 62.7% | **47/162 (29.0%)** | 8.7% | 5/10 |
| v3-judge-discipline | 517 | **66.5%** | 41/149 (27.5%) | 9.3% | 5/10 |

## Verdict per variant (against pre-registered targets)

- **v1 wide-evidence — FAILED its metric.** Truncation complaints barely
  moved (11.1% -> 10.4%) despite the packing budget rising 64k -> 163k+.
  Read: the judge's "truncated" complaints mostly describe the members'
  own outputs (heredocs cut by the members' completion budgets), not the
  packing ellipsis. The 64k default was real but was not the binding
  constraint at these step sizes.
- **v2 strict-commit — PASSED, weakly.** Verbatim compliance on contested
  steps 22.1% -> 29.0% (+6.9pt); null-rate degradation +8.5pt stays under
  the pre-registered 10pt tolerance. Still: 71% of contested commits are
  NOT byte-faithful even under a byte-for-byte prompt.
- **v3 judge-discipline — BACKFIRED.** The hard never-null rule + ordered
  factors made abstention *worse* (54.2% -> 66.5%). More instruction
  produced more hedging, not less. Clean negative result.

Per the pre-registered selection rule, **v2-strict-commit is the winner**
and carries to round 2A' confirmation.

## The larger finding

Prompt-level interventions moved these process metrics by single digits;
none moved resolve counts at all (5/10 under every config — and note the
resolved *sets* differ across rows: astropy-14508 resolves under
v1/v2/v3 but not v0; pylint-7080 under v0 only; django-12125 under none,
vs round 1 where it was the fused-only win). Two conclusions:

1. **Commit discipline and judge abstention look like model-capability /
   pipeline-structure limits, not prompt bugs.** If verbatim adoption
   matters, it should be enforced mechanically (engine-side: emit the
   picked candidate's batch directly, as the no-tools `select_best` path
   already does) rather than requested rhetorically. That is a source
   change — out of scope for this branch's config-only rule, and now
   backed by evidence that the config surface cannot get there.
2. **Per-instance outcomes are noise-dominated at n=10**; only the fresh
   30-instance confirmation (2A') can say anything about outcome effects.

## Spend

Four fused dev rows ~= $6-8 by call volume (precise: OpenRouter export);
grading local/unbilled. Within the $15 cap.
