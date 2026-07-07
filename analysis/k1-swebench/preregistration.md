# k=1 SWE-bench arm preregistration: N=2 OSS panel, native tool calling

Frozen before any billed benchmark run. Governing plan:
`docs/fusion/k1-official-harness-plan-2026-07.md`. Vocabulary: N = panel
size, k = step budget per member before aggregation.

**This is the PRIMARY k=1 arm.** It exercises the product's shipped
step-mode path end-to-end with no prompt surgery: the scaffold sends native
`tools`, so the engine uses its built-in step judge/synthesizer prompts and
verbatim tool-batch adoption. The Terminal-Bench arm
(`analysis/k1-round1/`) is the secondary/robustness arm for text-protocol
harnesses (its pinned prompts are an adaptation, recorded there as
amendments). Execution order: this arm first.

## Question

When the fused N=2 OSS panel runs at k=1 — members each propose a native
tool-call step, the judge/synthesizer commits exactly one proposal — behind
the benchmark's endorsed scaffold and graded by the benchmark's official
harness, does the fused system resolve at least as many instances as its
best member run solo through the identical pipeline, and how much of the
solo-oracle headroom does it capture?

## Benchmark, scaffold, grading

- Dataset: `princeton-nlp/SWE-bench_Verified`, split `test` (500 instances;
  sorted instance-id list SHA-256
  `fad0fdea4fc2315e9b78cdf80882a32e32393297052e502e0e63c79ad648fb85`).
- Scaffold: **mini-SWE-agent v2** (2.4.5) with its stock `swebench.yaml`
  config — the scaffold the SWE-bench bash-only leaderboard standardizes on
  for apples-to-apples LM comparison. v2 uses native tool calling
  (`tools=[BASH_TOOL]` on every request), so every fused step exercises the
  engine's step-mode path with the product's built-in prompts. We change
  nothing about the scaffold; the model endpoint is the only variable
  across rows.
- Grading: the **official SWE-bench evaluation harness** run locally
  (`swebench.harness.run_evaluation`, Docker-based), on each row's
  `preds.json`. Resolved/submitted ids are read from the harness's report
  JSON.

## Instance set (frozen)

10 instances: `random.Random(42).sample(sorted_ids, 10)`, sorted —
committed in `instance_manifest.txt`. Smoke instance for plumbing
validation (excluded from analysis): `astropy__astropy-12907`, the first
sorted id not in the sample. Rule: run exactly the manifest ids; scaffold
or provider failure rows are reported as such, never re-drawn.

## Systems under test (frozen)

| row | endpoint | notes |
|---|---|---|
| solo-terminus | `openrouter/deepseek/deepseek-v3.1-terminus` direct | VALID at 32k (seed audit) |
| solo-qwen3 | `openrouter/qwen/qwen3-coder` direct | measured cleanly in Phase 0 |
| fused | `fusionkit/panel` via `fusionkit serve` with `config/panel.yaml` | N=2 (terminus + qwen3), judge/synth = terminus, k=1, built-in step prompts |

- Panel selection rationale identical to the Terminal-Bench arm
  (validated members only; lineage veto; kimi excluded as unmeasurable).
- Recorded limitation: judge/synthesizer (terminus) shares a family with
  one member; candidates are anonymized/order-randomized by the engine.
- **No prompt pinning in this arm** — the built-in step prompts are the
  object under test. Consequence (recorded): the serve process must not
  run from a CWD containing `.fusionkit/prompts/` (the loader would apply
  those committed trajectory-prompt files over the step prompts). The
  runner serves from `/tmp`; the boot command is in `config/panel.yaml`.
- Sampling: solo rows use mini's stock defaults end-to-end. Fused-row
  member completion cap is 8192 tokens (`config/panel.yaml`).

## Execution

- `analysis/k1-round1/scripts/setup_env.sh` (same session setup), then
  `analysis/k1-swebench/scripts/run_swebench.sh --phase all --confirm`
  (refuses to bill without `--confirm`; phases: solo, fused, grade).
- Order: solo rows first, fused, then grading (grading is unbilled local
  Docker work and can be rerun).
- Artifacts: mini output trees + `preds.json` per row and the official
  harness report JSONs under `runs/` (gitignored); committed record is the
  report plus recomputed tables.

## Metrics (recomputed from harness report JSONs, never stdout)

Via `scripts/analyze_swebench.py`:

1. Per-row resolved counts with Wilson 95% CIs.
2. Solo oracle (instance resolved by >= 1 solo member), headroom over best
   solo.
3. Fused minus best solo, and capture where headroom > 0.
4. Per-instance resolution grid (the complementarity evidence).

n=10 gives wide CIs; this is a feasibility + directional measurement,
pre-registered as such. No public claims follow from it.

## Validity rules and recorded asymmetries

- Truncation audit: fused-row member calls hitting the 8192-token cap are
  counted from server logs; > 10% truncated member calls invalidates the
  fused row at this budget (one rerun at 16384 within the cap).
- mini's per-instance limits: `step_limit: 250` applies to all rows.
  `cost_limit: $3` is computed by litellm and is **live for solo rows but
  inert for the fused row** (litellm cannot price `fusionkit/panel`;
  `MSWEA_COST_TRACKING=ignore_errors`). Recorded asymmetry; the spend cap
  and step limit bound the fused row.
- Provider failures: instances failing on provider errors are reported per
  row; a row with > 2 such instances is marked degraded.

## Spend

- Cap: **$25.00 total** for this arm across all three rows (OpenRouter
  billed cost; OpenRouter activity export is the accounting source).
- Solo worst case is additionally bounded by mini's $3/instance
  cost_limit. Abort rule: if the two solo rows together exceed $12, stop
  and re-plan before the fused row.

## Outcome interpretation (no gate — this is measurement)

- fused >= best solo: the product's native k=1 step path survives a real
  repo-bugfix pipeline; scale the slice and/or proceed to comparison with
  the Terminal-Bench arm.
- fused < best solo: report the per-instance grid; rerun losing instances
  with OTLP tracing under a new preregistration to locate judge losses.
- headroom == 0: the slice cannot evidence fusion value; redraw a larger
  slice before further fused spend.

## Deviations

None at preregistration time.
