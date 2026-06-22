# Public Benchmark Comparison

Benchmark model fusion for coding by running real public benchmarks' official
runners and verifiers against the fusion gateway (treated as a single model), and
comparing the fused result to the published per-model leaderboard. We do not
reimplement benchmark tasks or verifiers, and we do not run single-model baselines
ourselves - the baselines are cited from public leaderboards.

These are real public benchmark runs when an external runner adapter is wired up.
Without an adapter the command emits an explicit `unavailable` comparison so CI
stays green; it still reports whether the panel even has oracle headroom for
fusion to help.

## Strategy

- Borrow the harness: point each suite's official runner at the gateway base URL.
  The gateway already speaks OpenAI Chat, Anthropic Messages, and OpenAI Responses
  and exposes itself as one model (`fusionkit/panel`).
- Borrow the baselines: read per-model scores (and cost) off the public
  leaderboard instead of running single models ourselves.
- Lead with headroom: a fusion benchmark is a panel-diversity benchmark. Report
  the oracle ceiling and failure correlation first - if the panel is lopsided,
  no judge can make fusion win, and that is the finding.

## Panel composition matters

The shipping default (`gpt-5.5 + claude-sonnet-4-6`) is lopsided: one member is
far stronger, so the oracle ceiling barely exceeds the best single model. Benchmark
fusion with a decorrelated peer panel instead (`decorrelated-peers`:
gpt-5.5 + claude-opus-4.8 + gemini-3-pro). See
`configs/benchmark-panel.example.yaml`.

## Suites

- SWE-bench Pro (public split) - primary real-world headline; fusion acts as the
  patch-producing agent, scored by the official secure harness. Do NOT use the
  deprecated SWE-bench Verified.
- Aider polyglot - cleanest single-variable ablation: identical harness with
  published per-model scores and a built-in cost column.
- Terminal-Bench 2.x - agentic headline; every leaderboard row is an Agent+Model
  pair, so fusion is naturally submitted as a new agent.
- LiveCodeBench - optional contamination-controlled cross-check via a time window
  after the panel models' training cutoffs.

## Two mount modes

- fusion_as_agent: fusion is the agent and produces the patch; the benchmark's
  official evaluator scores it (SWE-bench Pro, Terminal-Bench).
- fusion_behind_agent: the benchmark's own agent drives and calls the gateway per
  turn; compare to its published per-model numbers on the identical harness
  (Aider polyglot, LiveCodeBench).

## Subset first

The recommended first run is a small subset (10-20 tasks) to validate the
pipeline before any full pass. Use `--subset`:

```bash
fusionkit serve -c configs/benchmark-panel.example.yaml &
fusionkit public-bench \
  --suite aider-polyglot \
  --panel decorrelated-peers \
  --subset 15 \
  --runner-command "python tools/aider_gateway_adapter.py" \
  --output out/aider.jsonl \
  --report out/aider-comparison.md
```

## Runner adapter contract

The `--runner-command` adapter receives the request as JSON on stdin and emits a
normalized run envelope on stdout. See
`packages/fusionkit-evals/fixtures/public-bench/aider-polyglot-subset.sample.json`
for the shape. Key fields: `suite`, `resolved_tasks`, `passed_tasks`, optional
`score`, optional `cost_total_usd`, and a `tasks` array whose rows may include
`candidate_scores` (per-panel-member success) so oracle and failure-correlation
metrics can be measured from the run itself.

A missing adapter binary is reported as `unavailable`; a non-zero exit or
unparsable output is reported as `failed`. Neither aborts the report.

## Production reliability

The harness is built so a full-scale number is trustworthy, not just runnable.

- Sandboxed execution: untrusted model code runs via a pluggable sandbox
  (`BENCH_SANDBOX`, default `local`) with a scrubbed environment (no API keys),
  CPU/memory/file-size limits, and an output cap. A `docker` backend
  (`--network none`, read-only, pids/mem/cpu limits) is available for full/CI runs.
- Error taxonomy, never a silent drop: each task is `scored`, `model_failed`,
  `infra_error`, or `excluded`. Only `scored` tasks form the denominator; transient
  failures (timeout/429/5xx) are retried with exponential backoff before counting,
  so an infra failure on a hard task cannot inflate the score.
- Checker fidelity: choose `exact`, `token`, `float` (tolerance), or
  `case_insensitive` per problem (`LCB_CHECKER`); the full official test set runs
  by default (`LCB_MAX_TESTS=0`).
- Frozen manifest + pinning: set `LCB_MANIFEST` to a committed list of
  `question_id`s plus the dataset version and contamination window, so runs are
  comparable over time (replaces drift-prone "most recent N"). See
  `packages/fusionkit-evals/fixtures/public-bench/livecodebench/manifest-2025h2-medium-hard.example.json`.
- Statistical rigor: pass@1 is reported with a 95% Wilson interval; helpers exist
  for pass@k, multi-seed aggregation, and bootstrap CIs. Use >=100 tasks and >=3
  seeds for a real number.
- Provenance + audit: every run records repo SHA, package versions, prompt-template
  hash, model versions, dataset revision, sandbox/checker, and timestamps; per-task
  raw output, extracted code, per-test results, and stderr are persisted for audit.
- Resumability + caching: per-task results are cached (keyed by panel + scoring
  version), so runs resume and a checker/extractor change invalidates stale entries.
- Regression tracking: `--ledger` appends each run and reports drift vs the last
  comparable run.

### Honest limitations

- Cost is currently `solver_candidates_only` (judge + synthesizer token cost is not
  surfaced in-process yet); this is recorded in provenance as `cost_scope`.
- Faithful execution covers `stdin` problems; special-judge and functional-call
  problems are marked `excluded` rather than mis-graded.

## Honesty boundaries

- Baseline numbers are cited from public leaderboards and may use a different
  harness version or date than the fusion run.
- Keep the harness/version fixed per comparison; do not compare a fused number to
  a single-model number from a different harness.
- Public suites may be contaminated; LiveCodeBench's time window is the
  contamination-controlled cross-check.
