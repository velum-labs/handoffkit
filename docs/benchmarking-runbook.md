# Benchmarking Runbook and Learnings

Operational guide for running fusion coding benchmarks: what we learned, the
conventions that keep results trustworthy, the gotchas that cost time, and the
exact commands. Companion docs go deeper:

- [public-benchmark-comparison.md](public-benchmark-comparison.md) - the public-suite strategy and reliability features.
- [prompt-tuning.md](prompt-tuning.md) - the automated decision-only prompt tuner.
- [model-fusion-learnings.md](model-fusion-learnings.md) - earlier fusion notes.

## 1. Empirical learnings

- Classic algorithm sets are saturated. A `gpt-5.5 + claude-opus-4-8` panel scored
  15/15 on hand-picked LeetCode-style problems (both models solved every one), so
  oracle = best-single = fused = 100% and fusion shows nothing. Saturated sets are
  fine as smoke tests, useless for measuring fusion value.
- SWE-bench Verified is deprecated (saturated + contaminated). Use SWE-bench Pro,
  Terminal-Bench 2.x, or LiveCodeBench (post-cutoff window) for unsaturated signal.
- Panel composition decides whether fusion can win (Principle 0). A lopsided panel
  (one strong + one weak model) has almost no oracle headroom. But a panel of two
  strong peers rarely disagrees, so judge-decidable "decision tasks" are scarce -
  on an 8-task LiveCodeBench slice only 1 task was divergent. For both benchmarking
  and tuning you want decorrelated peers AND enough volume (or a diverse 3rd model)
  to produce disagreement.
- Fusion moves in both directions. On real LiveCodeBench tasks we saw a judge-regret
  loss (a candidate passed, the fused answer failed) and a synthesis win (fused
  passed where both candidates failed). Treat surprising wins as suspect until the
  per-task artifacts confirm they aren't extraction/scoring artifacts.
- Trust within-run metrics, not the leaderboard. The headline is fusion vs
  best-single vs oracle/regret with a Wilson CI on the same tasks. Published
  leaderboard numbers use a different harness/model/subset and are context only.
- Execution-based verification is mandatory. Score coding by running tests, never by
  text match. Only `stdin` problems are graded faithfully today; special-judge and
  functional-call problems are marked `excluded`, not mis-graded.
- Cost/latency reality: LiveCodeBench hard problems with reasoning models run
  ~$0.13/task and ~200s/task. Judge+synth token cost is not yet captured
  (`cost_scope = solver_candidates_only`).

## 2. Conventions

- Secrets: API keys live in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Source
  it (`set -a && source .env && set +a`); never pass keys on the command line.
- Datasets: LiveCodeBench uses a loading script, so it needs `datasets<4`. Run those
  commands under `uv run --with 'datasets<4' ...`.
- Sandbox: untrusted model code runs in a sandbox (`BENCH_SANDBOX`). Use `local`
  for dev (env-scrubbed, resource-limited, but NOT network-isolated on macOS) and
  `docker` for full/untrusted runs (verified: `--network none`, no host env, mem/CPU
  /pids limits). Default to `docker` for anything at scale.
- Reproducibility: pin a frozen manifest (`LCB_MANIFEST`) of exact `question_id`s +
  dataset version for comparable runs; example at
  `python/fusionkit-evals/src/fusionkit_evals/data/fixtures/public-bench/livecodebench/manifest-2025h2-medium-hard.example.json`.
- Caching/resumability: the public-bench adapter caches per task (keyed by panel +
  scoring version), so reruns resume cheaply. Bump `SCORING_VERSION` in the adapter
  when extraction/checker/execution logic changes so stale cache is invalidated.
- Subset-first: always validate the pipeline on a small `--subset` before a full run.
- Statistical rigor for real numbers: >=100 tasks and >=3 seeds; report pass@1 with
  a Wilson interval; use McNemar for paired prompt comparisons.
- Quality gate before committing: `uv run ruff check .`, `uv run pyright`,
  `uv run pytest`. Coverage >=80 is an aspirational target
  (`uv run coverage run -m pytest && uv run coverage report`); CI runs pytest
  without a coverage gate.
- The full `decorrelated-peers` panel includes a Gemini member, so it needs
  `GEMINI_API_KEY` in addition to `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.

## 3. Gotchas (learned the hard way)

- `datasets>=4` removed script datasets - pin `datasets<4` or LiveCodeBench fails to load.
- Model id spelling varies by artifact:
  `configs/benchmark-router.example.yaml` and the `gpt-opus-smoke` registry
  preset use `claude-opus-4-8` (hyphens), while the `decorrelated-peers`
  registry preset uses `claude-opus-4.8` (dot). Copy the id from the artifact
  you are actually using.
- Raise the RouteKit endpoint timeout when a reasoning model needs more than
  the default. A 120s timeout can expire while reasoning models generate long
  solutions to hard problems, and (before the taxonomy fix) one timeout aborted
  the whole batch.
- Set `max_tokens` to ~6000-8000 for hard problems.
- Decision tasks are scarce with strong 2-model panels. Use a larger `--subset` or
  add a diverse/weaker third model to create disagreement, or the tuner has nothing
  to optimize.
- Secrets must not reach the sandbox - the local backend scrubs env; the docker
  backend passes no host env. Do not add `--env` passthrough.
- The candidate-bank build (tuning) is NOT per-task resumable today: the bank is
  written only after the full panel pass completes, so interrupting mid-build loses
  it. The public-bench adapter, by contrast, IS per-task cached. (Future: make the
  bank build per-task cached too.)
- Baseline comparison guardrail: the CLI no longer headlines `uplift_vs_best_baseline`
  against the leaderboard; the within-run number is the headline.

## 4. Command reference

Bench commands live in the separately installed maintainer package under
`fusionkit-bench ...`.

The public Fusion gateway reads `.fusionkit/fusion.json` v4 and does not accept
a YAML `-c` flag. Scaffold it before booting an external-runner endpoint:

```bash
fusionkit init
fusionkit serve
```

The in-process `fusionkit-evals` adapters consume the internal sidecar YAML in
`configs/benchmark-panel.example.yaml`. Start its RouteKit gateway separately,
then run a subset:

```bash
set -a && source .env && set +a
routekit --config configs/benchmark-router.example.yaml \
  serve --no-portless --port 8787
```

In another shell:

```bash
set -a && source .env && set +a
export FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.example.yaml
export LCB_MIN_DATE=2025-01-01 BENCH_SANDBOX=docker LCB_CONCURRENCY=4
uv run --package fusionkit-evals --with 'datasets<4' fusionkit-bench public \
  --suite livecodebench --panel decorrelated-peers --subset 15 \
  --runner-command "python python/fusionkit-evals/src/fusionkit_evals/adapters/livecodebench_adapter.py" \
  --output out/lcb.jsonl --report out/lcb.md --ledger out/ledger.jsonl
```

Show cited leaderboard baselines:

```bash
uv run --package fusionkit-evals fusionkit-bench public-baselines --suite livecodebench
```

Automated prompt tuning (builds a candidate bank once, then optimizes):

```bash
set -a && source .env && set +a
export LCB_MIN_DATE=2025-01-01 BENCH_SANDBOX=local
uv run --package fusionkit-evals --with 'datasets<4' fusionkit-bench tune-prompts \
  --config configs/benchmark-panel.example.yaml \
  --role synthesizer_system --subset 24 --bank-max-tests 8 \
  --max-iterations 6 --patience 3 --optimizer-model gpt \
  --bank .fusionkit/tuning/bank.json \
  --prompts-out .fusionkit/prompts --report out/tuning.md
```

Reuse a prebuilt bank by pointing `--bank` at an existing file (skips the panel pass).

## 5. LiveCodeBench adapter env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `FUSIONKIT_BENCH_CONFIG` | (required) | Internal sidecar/eval YAML: RouteKit URL plus namespaced model IDs; not a public Fusion v4 config. |
| `BENCH_SANDBOX` | `local` | `local` or `docker` sandbox backend |
| `LCB_VERSION` | `release_v6` | dataset version tag |
| `LCB_MIN_DATE` | `2025-01-01` | contamination window floor (recent-N mode) |
| `LCB_DIFFICULTY` | `medium,hard` | difficulty filter (recent-N mode) |
| `LCB_MANIFEST` | (unset) | frozen manifest path (overrides recent-N) |
| `LCB_MAX_TESTS` | `0` | tests/task cap (0 = full official set) |
| `LCB_TEST_TIMEOUT_S` | `8` | per-test wall clock |
| `LCB_CONCURRENCY` | `4` | concurrent tasks |
| `LCB_RETRIES` | `3` | retries on transient provider errors |
| `LCB_CHECKER` | `exact` | `exact`/`token`/`float`/`case_insensitive` |
| `LCB_CACHE_DIR` | `~/.cache/fusionkit-bench/livecodebench` | per-task result cache |
| `LCB_ARTIFACTS_DIR` | `<cache>/artifacts` | per-task audit artifacts |

## 6. Production readiness status

Done: error taxonomy + retries, sandbox (local + verified docker), checker fidelity,
robust extraction + artifacts, scoring-versioned cache, frozen-manifest support,
Wilson CIs, provenance, drift ledger, the automated prompt tuner.

Outstanding before a publishable number: full cost accounting (judge+synth),
a >=100-task x >=3-seed run, confirmed per-model contamination cutoffs, a CI subset
gate, an optional signed receipt, and the separate execution-grounded selection
lever (closes the measured judge regret).
