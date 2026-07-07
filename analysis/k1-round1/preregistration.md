# k=1 round-1 preregistration: N=2 OSS panel on Terminal-Bench

Frozen before any billed benchmark run. Governing plan:
`docs/fusion/k1-official-harness-plan-2026-07.md`. Vocabulary: N = panel
size, k = step budget per member before aggregation.

## Question

When the fused N=2 OSS panel runs at k=1 behind the benchmark's own harness
(no custom scaffolds, no custom grading), does the fused system resolve at
least as many tasks as its best member run solo through the identical
harness — and how much of the solo-oracle headroom does it capture?

This is the first measurement of step-level fusion anywhere in the program:
all prior capture evidence is single-shot terminal-answer fusion in the
internal calibration harness.

## Benchmark and harness

- Dataset: `terminal-bench-core==0.1.1` (80 tasks; sorted-id list SHA-256
  `ba23ee7c8fef02ca200580f2e9af947c72baaed8dff86a8f3073cbd980eeb2b9`).
- Harness: the benchmark's own `tb` CLI with its own `terminus-2` agent
  (JSON parser, default settings). We change nothing about the harness; the
  model endpoint is the only variable across rows.
- Grading: the benchmark's own container checks (`is_resolved` per trial in
  `results.json`).
- Harness protocol note (recorded, not a deviation): `terminus-2` is a
  text-protocol agent (structured JSON parsed from text; no OpenAI `tools`
  field). Each agent turn is therefore one single completion per panel
  member fused per step — k=1 by construction — but the engine's
  tools-absent prompt variants are exercised, not the step-mode prompts. A
  native tool-calling scaffold (mini-SWE-agent v2, round 2) covers that arm.

## Task set (frozen)

12 tasks: `random.Random(42).sample(sorted_ids, 12)` over the 80 sorted task
ids, then sorted — committed in `task_manifest.txt`. Rule: run exactly these
ids; any harness-side failure rows are reported as such, never re-drawn.

## Systems under test (frozen)

| row | endpoint | notes |
|---|---|---|
| solo-terminus | `openrouter/deepseek/deepseek-v3.1-terminus` direct | VALID at 32k (seed audit) |
| solo-qwen3 | `openrouter/qwen/qwen3-coder` direct | measured cleanly in Phase 0 |
| fused | `fusionkit/panel` via `fusionkit serve` with `config/panel.yaml` | N=2 (terminus + qwen3), judge/synth = terminus, k=1 |

- Panel selection rationale: the only two OSS models with valid
  measurements in our records that pass the lineage veto against each other
  (DeepSeek vs Qwen families). `kimi-k2-thinking` (product default) is
  excluded: not measurable at practical budgets (seed audit, 64k rung).
- Recorded limitation: the judge/synthesizer (terminus) shares a family
  with one panel member. Candidates are anonymized and order-randomized by
  the engine, so exposure is stylistic self-preference only; a
  panel-external judge is a round-2 variable, not tuned here.
- Sampling: solo rows use the harness's defaults end-to-end. The fused row
  uses the harness's request as received; server-side member completion cap
  is 8192 tokens (`config/panel.yaml`), ample for per-step proposals.

## Execution

- `scripts/setup_env.sh` then `scripts/run_round1.sh --phase all --confirm`
  (the script refuses to bill without `--confirm`).
- Order: solo rows first, fused last (fail-fast on harness issues at
  baseline cost).
- Artifacts: full `tb` output trees under `runs/` (gitignored), logs, plus
  `runs/git_sha.txt` and `runs/tb_version.txt`. The committed record is the
  report plus recomputed CSV/tables.

## Metrics (recomputed from results.json, never stdout)

Via `scripts/analyze_round1.py`:

1. Per-row resolved counts with Wilson 95% CIs.
2. Solo oracle (task resolved by >= 1 solo member), headroom over best solo.
3. Fused minus best solo (the decision number) and capture where headroom > 0.
4. Per-task resolution grid (the complementarity evidence).

n=12 gives wide CIs; this round is a feasibility + directional measurement,
pre-registered as such. No public claims follow from it regardless of
outcome (the plan's Step-5 rule).

## Validity rules

- Truncation audit: any fused-row step hitting the 8192-token member cap is
  counted from server logs; if > 10% of member calls truncate, the fused row
  is invalid at this budget and is rerun once at 16384 within the same cap.
- Provider failures: trials failing on provider errors (not task failure)
  are reported per row; a row with > 2 such trials is marked degraded.
- Agent-timeout parity: identical harness timeout settings across rows; the
  fused row's per-step latency is expected to be ~2-3x solo — if fused
  trials fail on harness timeouts, that is reported as an infrastructure
  failure mode, not silently retried with different settings.

## Spend

- Cap: **$25.00 total** for this round across all three rows (OpenRouter
  billed cost; the serve ledger + OpenRouter activity export are the
  accounting sources).
- Worst-case estimate: solo rows ~$1-3 each; fused ~3-4x one solo row.
  Abort rule: if the two solo rows together exceed $12, stop and re-plan
  before the fused row.

## Pass/outcome interpretation (no gate — this is measurement)

- fused >= best solo (point estimate): step-level fusion survives contact
  with a real agentic harness; proceed to a larger slice and round 2
  (tool-calling scaffold).
- fused < best solo: report the per-task grid; for per-step judge
  diagnostics, rerun the losing tasks with the engine's OTLP tracing
  exported to a local collector (standard `OTEL_EXPORTER_OTLP_*` env),
  under a new preregistration, before iterating judge configuration.
- headroom == 0 on this slice: the slice cannot evidence fusion value
  regardless of capture; report and re-draw a larger slice in round 2.

## Amendments before first billed manifest run (2026-07-07)

Recorded openly; no manifest task had been run when these were made.

1. **Fused commit semantics pinned to verbatim selection**
   (`synthesis_select_best: true` in `config/panel.yaml`). As originally
   drafted, the tools-absent path would have used full synthesis — an LLM
   rewrite of the candidates each step — which can merge command batches
   across candidates, exactly what the product's k=1 step mode forbids for
   tool batches. With select-best, the judge names one candidate and its
   content is committed verbatim, matching step-mode commit semantics on a
   text-protocol harness. When the judge names no best candidate (null),
   the engine composes; such steps are a recorded diagnostic, not a
   deviation.
2. **Known asymmetry recorded — harness context bookkeeping.** terminus-2
   sizes its context-management (proactive summarization) from litellm's
   model registry. For the solo rows it knows the real model limits; for
   `fusionkit/panel` (unknown id) it falls back to a 1M-token limit, so
   harness-side summarization effectively never triggers for the fused row
   and very long tasks may instead hit the members' real context limits as
   provider errors. Reported per-trial via `results.json` failure modes;
   biases against the fused row if it biases anything.

## Deviations

None at preregistration time.
