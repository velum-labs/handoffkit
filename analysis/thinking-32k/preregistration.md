# Thinking-model 32k measurement preregistration

Frozen before running provider calls for this round.

## Purpose

Measure the first valid pass rates for the thinking-style models whose C3-R16K
results were invalid or provisional because more than 10% of rows truncated at
the 16k completion cap.

## Task set

- Manifest: `analysis/phase0/c3_task_manifest.json`
- Manifest SHA-256: `31a1be514ef78628ce39146804f8ef160efe29b13017357832972f8854dc86e1`
- Task count: 60
- Source bank: `analysis/phase0/cache/c3r16k_candidate_bank.json`
- Rule: task ids must match the manifest exactly and in order.

## Models

Only these two endpoint ids will be run at 32k:

| endpoint_id | provider | model id |
|---|---|---|
| `kimi` | OpenRouter | `moonshotai/kimi-k2-thinking` |
| `sonnet` | Anthropic | `claude-sonnet-4-6` |

The `sonnet` id is the same Anthropic claude-sonnet-class id used by the
Phase-0 C3/C3-R16K script.

## Run configuration

- Subcommand: `build-bank`
- Models: `kimi,sonnet`
- Completion budget: `--max-tokens 32768`
- Request timeout: `--request-timeout-s 600`
- Concurrency: `--concurrency 3`
- Spend cap: `$20.00` total for this round
- Outcomes: `analysis/thinking-32k/outcomes_32k.csv`
- Ledger: `analysis/thinking-32k/spend_ledger.jsonl`
- Candidate bank: `analysis/thinking-32k/cache/candidate_bank_32k.json`
- Log: `analysis/thinking-32k/cache/thinking32k_full.log`

## Truncation and validity rule

For a row at budget `B`, truncation is recorded as
`completion_tokens >= B` from the outcomes CSV. A model's pass rate is valid
only if at most 10% of its 60 rows truncate, i.e. no more than 6 rows.

If `kimi` has more than 6 truncated rows at 32k, run one escalation for
`kimi` only at `--max-tokens 65536`, still within the same `$20.00` spend cap.
If `kimi` still has more than 6 truncated rows at 64k, report
`kimi` as not measurable at practical budgets. Do not escalate `sonnet`.

## Reported comparison

The report will compare paired results against the 16k run in
`analysis/phase0/c3r16k_outcomes.csv`:

- pass rate with Wilson 95% CI;
- truncation counts;
- mean completion tokens;
- spend from the ledger/outcomes;
- OSS-relevant context versus the 16k scores of `deepseek`, `qwen3`, and
  `gpt55`, including whether the "gpt-5.5 dominates this slice" conclusion
  changes.

All reported pass rates and truncation counts will be recomputed directly from
the output CSV files, not from script stdout.
