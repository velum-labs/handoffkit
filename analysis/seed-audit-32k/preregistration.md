# D10 seed-panel truncation audit preregistration

Frozen before running provider calls for this round.

## Purpose

The recommended repo-bugfix flagship seed panel (D10) is
`deepseek-r1-0528 + deepseek-v3.1-terminus + qwen3-235b-a22b-thinking-2507`.
Two of the three are thinking-style models, and the program's most repeated
lesson (C3-R16K, Step 2) is that thinking models produce invalid pass rates
unless a truncation audit passes. None of the three has ever been measured in
our harness. This round measures, for each seed model, whether it is validly
measurable at practical completion budgets, before any capture pilot spends
money on it.

This audit runs on the standard 60-task algorithmic slice because that is the
only deterministic grading path in the harness today (Step 4 unlocks repo
bugfix). The target metric is measurement validity (truncation), not domain
pass rate; algorithmic pass rates are recorded as context only.

## Task set

- Manifest: `analysis/phase0/c3_task_manifest.json`
- Manifest SHA-256: `31a1be514ef78628ce39146804f8ef160efe29b13017357832972f8854dc86e1`
- Task count: 60
- Source bank: `analysis/phase0/cache/c3r16k_candidate_bank.json`
- Rule: task ids must match the manifest exactly and in order.

## Models

All three run through OpenRouter, ids and prices checked against the
OpenRouter models endpoint on 2026-07-05:

| endpoint_id | model id | $/M prompt | $/M completion |
|---|---|---:|---:|
| `r1` | `deepseek/deepseek-r1-0528` | 0.50 | 2.15 |
| `terminus` | `deepseek/deepseek-v3.1-terminus` | 0.27 | 0.95 |
| `qwen3t` | `qwen/qwen3-235b-a22b-thinking-2507` | 0.1495 | 1.495 |

## Run configuration

- Runner: `analysis/seed-audit-32k/scripts/seed_audit_runner.py` (registers the
  three endpoints, then delegates to the committed thinking-32k runner logic).
- Provider smoke first: one 16-token call per endpoint; abort the round if any
  endpoint fails the smoke.
- Main run: subcommand `build-bank`, models `r1,terminus,qwen3t`,
  `--max-tokens 32768`, `--request-timeout-s 900`, `--concurrency 6`,
  `--hard-task-timeout-s 3600`.
- Spend cap: `$20.00` total for this round (`--budget-usd 20`).
- Outcomes: `analysis/seed-audit-32k/outcomes_32k.csv`
- Ledger: `analysis/seed-audit-32k/spend_ledger.jsonl`
- Candidate bank: `analysis/seed-audit-32k/cache/candidate_bank_32k.json`
- Log: `analysis/seed-audit-32k/cache/seed_audit_full.log`
- Worst-case cost estimate at 32k (all rows truncate): ~$9.5 across the three
  models, well under the cap.

## Truncation and validity rule

Identical to Step 2: for a row at budget `B`, truncation is
`completion_tokens >= B`. A model's pass rate is valid only if at most 10% of
its 60 rows truncate (no more than 6 rows).

Escalation: any model with more than 6 truncated rows at 32k is rerun once at
`--max-tokens 65536` (outcomes in `outcomes_64k_escalated.csv`), still within
the same $20.00 cap; if the cap would be exceeded, escalate only the model
with the fewest truncated rows (most likely to become valid). A model still
above 6 truncated rows at 64k is reported as **not measurable at practical
budgets** and flagged for exclusion or budget-renegotiation before any
capture pilot that includes it.

Provider failures: rows with `call_status != succeeded` are excluded from the
truncation denominator and rerun individually once (targeted rerun files in
`cache/`), as in Step 2.

## Reported outcomes

For each model and budget rung, recomputed directly from the outcomes CSVs:

- truncation count and validity verdict under the 10% rule;
- pass@1 with Wilson 95% CI (context only, algorithmic slice);
- mean completion tokens;
- spend by endpoint from the ledger;
- a binding recommendation per model: VALID at 32k / VALID at 64k /
  NOT MEASURABLE — with the consequence for the D10 seed panel spelled out.

## Deviations

None at preregistration time.
