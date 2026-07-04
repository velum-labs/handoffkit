# Coding Capability Index — Critical Analysis and Unified Methodology

**Subject:** full critical analysis of the *Coding Model Router Benchmark Plan*
(`coding_model_router_benchmark_plan(1).md`, 2026-07-03 revision) versus
[handoffkit PR #52](https://github.com/velum-labs/handoffkit/pull/52)
(`model-area-index`, branch `cursor/panel-intelligence-85f4`, head `7f82dfd`),
and the specification of a combined, optimal methodology.

**Framing constraint (from the product brief):** the goal is not a benchmark
(performance on one task set in one domain) but a **capability index across
coding subdomains** — an aggregation layer over many benchmarks whose
fundamental unit is the **task**, enriched with metadata (domain, subdomain,
task type, language, framework, difficulty, per-model results, traces,
outputs). The index must inform ensemble priors: which models are strong per
task type, which make complementary errors, and which top-K models to select
for an ensemble of generators + judge, eventually fronted by a router. The
central hypothesis: **the best ensembles are built from models that are strong
in different subdomains and exhibit complementary error patterns — not from
the models with the highest average scores.**

---

## 0. Executive summary

| | Router Benchmark Plan | PR #52 `model-area-index` |
|---|---|---|
| What it is | ~4,900-line methodology document; zero code | ~4,000-line working Python package; CI-tested |
| Center of gravity | Run-your-own calibrated benchmark + router | No-run public-signal aggregation + panel shortlist |
| Unit of analysis | The calibrated *run* | The aggregate *score row* |
| Fatal flaw | Scope (redundant mega-harness), pairwise-only complementarity, no living index artifact | Source-as-taxonomy areas, task-level evidence discarded at ingestion, heuristic math at the decision point |
| Best contribution | Evidence-tier epistemology + apples-to-apples comparability (§35) + informativeness-driven calibration selection (§34) | Typed evidence boundaries, model-identity facets, provenance/data-quality machinery, extensible source registry |

**Verdict.** The plan is the right methodology with no implementation and a
scope problem; PR #52 is the right implementation substrate with a methodology
gap at its center. Neither honors the product brief's requirement that the
task be the fundamental unit. The optimal system is:

1. **Keep PR #52's warehouse machinery** (pydantic schemas, `SourceSpec`
   registry, snapshot provenance, `DataQualityReport`, strict outcome-group
   guards, identity facets) as the Layer-1 substrate.
2. **Re-center it on the task**: promote per-instance public data
   (SWE-bench experiments, LiveCodeBench per-question, LiveBench per-question,
   BigCodeBench samples, LLMRouterBench instances) into `TaskOutcome` rows
   instead of collapsing them to aggregates.
3. **Adopt the plan's taxonomy, statistics, and three-layer evidence
   architecture**, replacing PR #52's source-derived areas and min–max/fixed
   weight scoring.
4. **Generalize complementarity from pairs to top-K-from-N** via
   oracle-coverage submodular selection with a judge-realizability discount.
5. **Use this repo's existing eval stack as Layer 2** (`candidate_bank`,
   `fusion_bench`, `fusion_hillclimb`, `benchmark_panel`) instead of building
   the plan's Inspect-AI mega-harness; feed calibrated results back into the
   index as top-tier evidence.
6. **Ship per-subdomain panel cards** as the product artifact, and stage the
   router (rules first, learned later) exactly as the plan prescribes.

The remainder of this report substantiates each claim with specifics.

---

## 1. Conceptual frame: benchmark vs. index

A **benchmark** answers "how well does model M perform on task set T under
harness H?" Its outputs are scores; its validity depends on holding T and H
fixed. An **index** answers "given everything publicly measurable, what should
I believe about model M's capability in subdomain D, and with what
confidence?" Its outputs are *priors with provenance*; its validity depends on
honest evidence typing and aggregation.

The two artifacts fail this frame from opposite directions:

- The plan builds a benchmark and treats the index (its "public prior
  dataset", §30.1) as scaffolding for benchmark task selection. The index is
  a means; the benchmark report is the end. The product brief inverts this:
  the index is the product; calibrated runs are the *validation instrument*
  for the index.
- PR #52 builds an index but inherits the shape of the leaderboards it
  scrapes: its `ModelAreaMatrix` is a leaderboard-of-leaderboards. The task
  catalog (`BenchmarkTask`) and per-task outcomes (`TaskOutcome`) exist in the
  schema but are not the spine — no built-in source populates `TaskOutcome`,
  and the matrix is built exclusively from `ModelAreaScore` aggregates.

A useful test for any design decision below: *does it make the index more
predictive of calibrated ensemble value per dollar of run spend?* Everything
else is secondary.

---

## 2. Critical analysis: the Router Benchmark Plan

### 2.1 What the plan gets right

**(a) Evidence-tier epistemology (§29–31, §35.14).** The reliability grades
are the intellectual core:

| Grade | Data | Permitted use |
|---|---|---|
| A | Per-instance outcome + raw output/patch/log/trajectory | Direct router prior, judge training, failure analysis |
| B | Per-instance score under a different harness / incomplete metadata | Router pretraining at reduced weight |
| C | Pairwise human preference | Judge/reranker training only |
| D | Task labels/metadata only | Task selection, taxonomy coverage only |
| E | Aggregate leaderboard | Model shortlisting only |

with the governing maxim: *"Public results tell you where to look. Strict
calibrated runs tell you what is true for your model pair. Production route
runs tell you what to deploy."* This is the correct epistemology, and the
usage-policy-per-grade is what PR #52 lacks (it types the evidence but does
not restrict what each tier may *influence*, beyond the task-metrics gate in
`recommend_panel`).

**(b) Comparability methodology (§35).** Near-exhaustive and correct. The
highest-value items, in order:

1. *Unit-of-comparison naming* (§35.2): a result row is
   `model + provider backend + scaffold + prompt version + tool budget +
   route policy`, never "Qwen". This is the single most common source of
   silent corruption when merging public results.
2. *Strict-common-budget vs native-product mode* (§35.13), reported as
   separate columns, never averaged.
3. *Gateway invariants* (§35.7): pin or log resolved provider backend,
   disable fallbacks in strict mode, record pricing snapshots — directly
   relevant to this repo's gateway layer.
4. *Judge input boundary* (§35.10): the judge may see public test logs, build
   logs, diff stats; never hidden-test outcomes or gold patches. Position,
   verbosity, patch-size, and identity bias are measured, not assumed away.
5. *Reproducibility manifest* (§35.16): benchmark version, task-registry
   hash, harness/agent/prompt/grader versions, docker digest, per-model
   params hash. This matches the repo rubric's no-corner-cutting rule
   (`docs/fusion/FUSION_VALUE_RUBRIC.md` §0).

**(c) Taxonomy philosophy (§4, §10, §18, §22).** Multi-axis labels
(`primary_domain × task_operation × context_shape × quality_axis ×
difficulty`), the rule that *clustering refines but never defines* the
taxonomy, and the acid test *"a label is useful only if it changes routing
decisions."* Also the explicit anti-pattern (§22.1): do not treat benchmark
source as domain — `SWE-bench task = repo_bugfix + python + multi_file_repo +
bugfix_debug`, not `SWE-bench = backend`.

**(d) Informativeness-driven calibration selection (§34).** Under a run
budget, select tasks that maximize routing information:

```
candidate_score =
    0.30 * disagreement            # variance of success across public models
  + 0.20 * entropy                 # binary entropy of mean success
  + 0.20 * label_undercoverage     # taxonomy cells below target n
  + 0.15 * expected_pair_complementarity
  + 0.10 * relevance_to_traffic
  - 0.10 * estimated_runtime
  - 0.15 * flakiness_risk
  - 0.20 * license_or_access_risk
```

and *avoid* tasks all public models solve, no public models solve, or whose
grading is flaky. This is exactly how to reconcile the product brief's cost
constraint ("running all benchmarks from scratch would be inefficient") with
the need for calibrated ground truth.

**(e) Honest statistics (§15, §35.12).** Paired design (every model sees
every task), McNemar for A-vs-B, Wilson-style intervals, the complementarity
quadrant (`A_correct_B_wrong`, `A_wrong_B_correct`, `both`, `neither`),
repo/source/date-based splits (never random task splits when tasks share a
repo), and a sober noise table: n=25/cell → ±20pp worst-case at 95%, n=50 →
±14pp, n=100 → ±10pp, n=400 → ±5pp. Notably, this repo already implements the
same statistics for Layer 2: `fusionkit_evals.prompt_tuning.mcnemar`,
`fusion_bench._failure_correlations`, and Wilson intervals per the rubric.

**(f) Judge as a benchmarked component (§13, §35.10).** Accuracy conditioned
on `exactly_one_correct` / `both_correct` / `both_wrong`, plus bias
measurement. PR #52 has no judge model at all — a real gap given that judged
ensembles realize only a fraction of oracle value.

### 2.2 Where the plan fails

**(1) Internal contradiction: taxonomy richness vs statistical power.**
The label space is ~10 domains × 7 operations × 8 context shapes × 9 quality
axes (multi-label), but the "serious" benchmark is 420–440 tasks and the
plan's own table says n=100 is the floor for a usable routing signal. At 440
tasks, only single-axis (per-domain) cells clear n≈40–60; virtually every
interesting intersection (`frontend_ui × bugfix_debug × visual_required`) will
sit at n<30 — "very noisy" by the plan's own standard. §8 ("only fill
routing-relevant cells") acknowledges but does not resolve the arithmetic.

*Consequence for the synthesis:* the taxonomy must be **validated on public
per-instance data first** (where n is in the thousands per cell) and only the
labels that provably change model rankings survive into the calibration
design. The plan runs this order backwards.

**(2) Hard-coded to 2 solvers; complementarity is pairwise-only.** Every
ensemble metric is a pair metric (`pair_oracle_gain(A,B)`, the quadrant table,
the A/B judge protocol). The product brief requires **top-K selection from a
pool of N** — a subset-selection problem over a per-task outcome matrix, not a
pair comparison. The plan even ingests the right data for this
(LLMRouterBench: 33 models × 400K+ instances) and never generalizes the math.
Nothing in the plan tells you whether {A,B,C} beats {A,B} at +1 member cost.

**(3) No living index artifact.** Outputs are a report, a router policy, and
a DuckDB of runs. There is no versioned index with a refresh contract ("new
frontier model ships → re-mine sources → re-rank → re-calibrate deltas"). The
plan's phases are campaign-shaped; the product brief requires a *product*
artifact (precomputed ensembles per subdomain) that stays current. The repo
rubric's §9.5 (pool-refresh playbook) points the same direction.

**(4) Scope: the mega-harness is mostly redundant here.** The recommended
stack (Inspect AI meta-harness + mini-agent + 8 adapter families + Docker +
Playwright + exploit graders + DuckDB + observability) is a very large
engineering surface. This repo already has: a bench runtime with outcome
classification (`fusionkit_evals.bench_runtime`), public-bench integration
with real harness invocation (`tests/test_fusion_bench.py` drives the actual
HandoffKit CLI), a frozen per-task candidate store (`candidate_bank`), panel
composition and headroom analysis (`benchmark_panel`, with
`LOPSIDED_SCORE_GAP = 0.2`), and hill-climb machinery with McNemar
(`fusion_hillclimb`). Rebuilding this in Inspect AI would burn the entire
budget the index is supposed to save. The genuinely missing pieces are
narrow: a Playwright/frontend grader and a SQL-execution grader.

**(5) Hand-set weights without sensitivity analysis.** The informativeness
score's weights (0.30/0.20/0.20/0.15/0.10/−0.10/−0.15/−0.20) are asserted, not
derived — the same flaw the plan would criticize in a leaderboard. Acceptable
for a v1 heuristic, but the plan should (and the synthesis does) mandate a
sensitivity check: the selected calibration set should be stable under ±50%
weight perturbation, else the selection is arbitrary.

**(6) No cross-source model-identity resolution.** §35.2 solves identity for
*your own* runs. But the public prior layer merges sources where the same
engine appears as `gpt-5`, `gpt-5 (high)`, `GPT-5 via Codex CLI`, or inside an
agent submission. Without identity facets, the prior layer double-counts
correlated variants and treats scaffold artifacts as model capability.
PR #52 solves exactly this (see §3.1(b)).

**(7) Licensing and availability are flagged, not resolved.** WebDev Arena
preference data, SWE-bench Pro (Scale AI), and Artificial Analysis all carry
license or access constraints. The plan lists `license_or_access_risk` as a
penalty term but has no gate that prevents restricted data from leaking into
a shipped artifact. The synthesis makes license a hard field on every row
with a validation check, not a soft penalty.

---

## 3. Critical analysis: PR #52 `model-area-index`

### 3.1 What the implementation gets right

**(a) Evidence boundaries in the type system.** Two orthogonal enums govern
every claim:

- `data_level`: `aggregate_score → subtask_score → task_metadata_only →
  model_answer → task_outcome → same_run_task_outcome`
- `decorrelation_evidence_level`: `none → aggregate_proxy →
  model_answer_replayable → task_vector`

with a hard runtime guard: `build_task_outcome_panel_metrics` raises
`ValueError` on mixed benchmark/version/harness/evaluator/attempt-budget/
output-type/area/subarea groups. Failure correlation is therefore
*structurally impossible* to fabricate from leaderboard aggregates. This is
the plan's Grade A–E idea implemented per-row and machine-checked — strictly
better than prose.

**(b) Model identity facets.** `ModelAreaScore` carries `base_model_key`,
`provider_model_id`, `model_alias`, `reasoning_effort`, `harness_or_agent`,
`is_agent_system`, `is_open_weight`. The tests confirm real inference
(`gpt-5-high → base_model_key="gpt-5", reasoning_effort="high"`; SWE-bench
rows get `is_agent_system=True, harness_or_agent="swe-bench-agent"`). This is
the missing §2.2(6) machinery from the plan, and it is essential for both
dedup (don't put two reasoning-effort variants of one engine on a "diverse"
panel) and scaffold-vs-model attribution.

**(c) Operational discipline.** Extensible `SourceSpec` registry (new sources
register without touching the fetch loop); tolerant-by-default live fetch
with per-source `ran/failed` and `--strict` for CI; snapshot hashing +
`retrieved_at` provenance on every row; row-level `DataQualityReport`
(duplicate rows, source/area mismatch, unknown provider, task-outcome rows
not marked same-harness-comparable, missing task counts on high-evidence
rows) with `--fail-on-data-quality-errors`; large generated snapshots kept
out of git (only a 3-row reviewed fixture committed). This is production-shaped
warehouse hygiene the plan never specifies.

**(d) Honest self-labeling at the decision point.** When no task outcomes are
supplied, `recommend_panel` emits the warning *"no task-outcome metrics
supplied; diversity uses capability-vector proxy"* and each member's `reason`
says "aggregate proxy diversity". Matrix cells built only from aggregates
carry *"aggregate proxy; not same-task decorrelation evidence"*; single-source
cells carry *"single-source cell; corroborate before making claims"*. The
system never overclaims — it merely underdelivers (next section).

### 3.2 Where the implementation fails

**(1) Source-as-taxonomy — the plan's cardinal sin, committed.** The "areas"
are benchmark identities renamed: `coding_edit` ≈ Aider polyglot,
`swe_repair` ≈ SWE-bench, `terminal_agentic` ≈ Terminal-Bench,
`competitive_programming` ≈ LiveCodeBench, `ui_to_code` ≈ UIBenchKit. There
is no operation axis, no language/framework axis, no context-shape axis
(a `subarea` string exists but holds source-specific slice names like
`pass_at_1` or `direct`). Consequences:

- The index cannot answer subdomain questions that cross sources
  ("best at TypeScript multi-file refactors", "best at SQL under long
  context") — the questions the product brief exists to answer.
- `PROFILE_AREA_WEIGHTS` inherits the distortion: the `coding-agent` profile
  is 0.30·Aider + 0.25·SWE-bench + 0.20·Terminal-Bench + 0.15·LCB +
  0.10·reasoning — a weighted vote of leaderboards, not a subdomain profile.
- Adding a new benchmark that covers an existing skill creates a *new area*
  instead of new evidence for an existing one, silently re-weighting every
  profile.

**(2) Task-level evidence is discarded at ingestion.** The LiveCodeBench
parsers consume genuine per-question, same-harness rows
(`question_id × model × pass@1`) and collapse them to per-model
`subtask_score` aggregates by difficulty slice. LiveBench likewise arrives as
per-question judgment rows and leaves as aggregates. These are precisely the
`task_outcome` rows the schema was built for: within one source, all models
ran under the official harness, so the strict-grouping guard is satisfied
*by construction*. The PR's own PR-description defends this as an evidence
boundary ("built-in fetchers emit `data_level="subtask_score"`, not
`task_outcome`"), but the boundary is drawn one level too conservatively: the
correct caveat is *cross-source* incomparability and *scaffold* attribution,
both of which the schema already expresses (`harness`, `harness_or_agent`,
`same_harness_comparable`). Meanwhile `TaskOutcome` — the type that powers
oracle headroom, unique wins, and failure correlation — is populated by
nothing except user-supplied `--task-outcome-snapshot` files. The result: the
recommender's task-evidence path is dead code in practice, and the index's
complementarity story rests entirely on the weak proxy.

**(3) The math is heuristic exactly where decisions are made.**

- *Normalization* (`_normalized_scores`): min–max within
  (benchmark, version, area, subarea, harness, prompting_mode, direction)
  cohorts. With small cohorts this is endpoint-pinned (some model is always
  1.0 and some 0.0 regardless of absolute gaps), unstable under model
  addition/removal (one new frontier model rescales everyone), and ties
  collapse to 0.5. No variance, no n-awareness.
- *Cell aggregation* (`_record_weight`, `_build_cell`): weight =
  `DATA_LEVEL_WEIGHTS[level] × SCORING_WEIGHTS[mode] × contamination_weight ×
  saturation_weight × freshness_weight × task_count_weight ×
  same_harness_weight` — seven multiplied hand-set factors
  (e.g. `aggregate_score`=0.45, `llm_judge`=0.35) with nothing setting
  contamination/saturation/freshness in the built-in parsers. "Confidence" is
  `min(1, mean(weight))` — a rhetorical number, not an interval. The plan's
  §15/§35.12 statistics (Wilson, paired tests, n-per-cell floors) are
  entirely absent.
- *Diversity* (`_candidate_diversity_score`): `1 − max cosine similarity`
  over area-vectors where **missing cells are imputed as 0.0**. Two models
  measured by the same two benchmarks look similar partly by shared coverage;
  two models with disjoint coverage look maximally diverse by construction.
  And even when clean, capability-vector distance is a weak proxy for *error*
  decorrelation — two models with near-identical capability profiles but
  independent per-task errors are the best fusion pair and score *worst* on
  this metric. (The code labels the proxy honestly; the problem is that
  honest labeling doesn't make the number useful for the one decision it
  feeds.)
- *Selection* (`recommend_panel`): greedy over
  `capability + 0.25·diversity + 0.35·task_evidence`, where task evidence is
  itself `min(1, 0.45·(1−mean_corr) + 0.35·unique_win + 0.2·headroom)` and
  cost enters as `score −= min(0.2, 0.03·log10(mean_cost+1))` plus a mean-cost
  filter. Five more hand-set constants; no cost/latency frontier; no
  judge-realizability discount (oracle headroom is rewarded as if the judge
  captured 100% of it).

**(4) No calibration loop — and no bridge to the one that already exists.**
A no-run index cannot validate its own priors: it cannot detect that a
leaderboard is contaminated, that a model's public score reflects a scaffold
rather than the engine, or that its predicted complementarity fails to
materialize under the production harness. The plan's Layer 2 is the answer,
and **this repo already implements it**: `candidate_bank.CandidateBank`
(frozen per-task pass flags per model), `fusion_hillclimb.diagnose_bank`
(oracle ceiling, best single, mean failure correlation, lopsidedness),
`fusion_bench` (judge-synthesis regret, failure correlations),
`benchmark_panel` (headroom + lopsidedness from published scores — itself a
tiny, hand-rolled precursor of what `model-area-index` should provide).
PR #52 references none of it, in either direction: the index doesn't emit
`BenchmarkPanel` presets, and calibrated `CandidateBank` results don't flow
back as `same_run_task_outcome` rows — the top evidence tier the schema
defines but nothing produces.

**(5) Contamination and saturation are schema fields, not mechanisms.**
`contamination_weight`, `saturation_weight`, `freshness_weight` exist on
`ModelAreaScore` with no built-in policy: no LiveCodeBench date-windowing
(the canonical contamination control for that source), no saturation
detection (an area where the top 10 models sit within noise of each other
carries almost no routing signal), no freshness decay. The plan's §35.15
contamination rules have no counterpart.

**(6) Structural debt.** `core.py` is 2,851 lines mixing schemas, 13 source
parsers, HTML/CSV scraping, normalization, matrix building, task-outcome
math, data quality, and recommendation. Live-scrape parsers (Aider HTML
regex, Terminal-Bench embedded-JSON extraction) are inherently brittle; the
tolerant-fetch design mitigates availability but not silent semantic drift
(a leaderboard column renaming can flow through as wrong numbers if the
parser still matches). There is no golden-snapshot regression test against
recorded payloads (unit tests use synthetic fixtures, which validate parsing
logic but not real-payload drift).

---

## 4. Head-to-head

| Dimension | Plan | PR #52 | Assessment |
|---|---|---|---|
| Unit of analysis | Calibrated run | Aggregate score row | Both wrong; must be the **task** |
| Taxonomy | Multi-axis, source-independent, cluster-refined | Flat source-derived areas | **Plan** |
| Evidence typing | Grade A–E prose policy | Typed + machine-enforced per row | **PR #52** mechanism + **plan** usage policy |
| Per-instance public mining | Core strategy (Grade A/B sources enumerated) | Absent (aggregates only) | **Plan** |
| Complementarity math | Pairwise quadrants + oracle gain, 2 models only | Failure corr + unique wins + weak proxy, K models | Neither does top-K-from-N; **synthesis required** |
| Statistics | Paired McNemar, Wilson, power floors | Min–max + 7 multiplied heuristic weights | **Plan** |
| Identity resolution | Own runs only | Typed facets for all rows | **PR #52** |
| Comparability controls | §35, near-exhaustive | Strict outcome-group guard only | **Plan** |
| Judge treatment | Benchmarked component, bias-measured | Absent | **Plan** |
| Cost/latency | Cost-per-success, frontier, regret | Raw fields + log-penalty | **Plan** |
| Contamination controls | Fresh/private/future holdouts, leak rules | Inert schema fields | **Plan** |
| Implementation | 0 lines | ~4,000 lines, tested | **PR #52** |
| Refreshability | Campaign phases | Live fetch + registry + snapshots | **PR #52** |
| Scope realism | Redundant mega-harness | Deliberately cheap no-run | **PR #52** |

---

## 5. Unified methodology

### 5.1 Three-layer evidence architecture

Adopt the plan's §38 layering; note that each layer already has an owner in
this codebase:

```
Layer 1 — PUBLIC PRIOR INDEX (no-run, cheap, refreshable)
  Owner: model-area-index (PR #52), re-centered on tasks per §5.2–5.5 below.
  May influence: shortlisting, panel candidates, calibration-task selection,
  router pretraining features. May never: back a public claim or a
  production routing decision on its own.

Layer 2 — STRICT CALIBRATED RUNS (billed, small, decisive)
  Owner: fusionkit-evals (candidate_bank, fusion_bench, fusion_hillclimb,
  benchmark_panel) — already implements paired stats, oracle/regret,
  decorrelation, McNemar.
  May influence: final panel composition, judge choice, router training,
  rubric claims (FUSION_VALUE_RUBRIC §1–2).

Layer 3 — PRODUCTION TELEMETRY (free, continuous, noisy)
  Owner: gateway cost meter + kernel replay records (partially existing).
  May influence: cost/latency estimates, drift alarms, refresh triggers.
```

Rows are tagged with their layer; the reporting rule is the plan's: **never
combine layers in one headline table.**

### 5.2 Data model (Layer-1 warehouse)

Keep PR #52's pydantic substrate; re-rank the tables so the task is primary.
Concretely, the warehouse has five row types (four exist in PR #52 already):

1. **`BenchmarkTask`** (task registry — primary table).
   Key: `(benchmark, benchmark_version, task_id)`, plus `task_fingerprint`
   (hash of prompt/repo snapshot where obtainable, for cross-version linking
   and contamination checks). Carries the taxonomy labels of §5.3, license
   field (hard-enforced, see §9), and artifact URIs. The plan's
   `gold_patch_uri` / `gold_test_patch_uri` fields are adopted with the
   never-shown-to-solver invariant.
2. **`TaskOutcome`** (per-task, per-system outcome — the evidence spine).
   Exists in PR #52 with the right fields (`harness`, `agent_scaffold`,
   `attempt_budget`, `same_harness_comparable`, identity facets via
   `model_key`/`base_model_key`). Two changes: (i) built-in sources populate
   it (see §6); (ii) add `layer: public_prior | calibrated | production` and
   `scaffold_confounded: bool` (true for e.g. SWE-bench submissions, where
   the row measures model+agent, not the raw model).
3. **`ModelAnswerArtifact`** (pointer to patches/completions/logs/traces) —
   exists; used for judge training (plan §33.3) and failure-mode labeling.
4. **`PairwisePreference`** (plan §32.3, new): WebDev-Arena-style rows,
   Grade C, judge-training only. License-gated.
5. **`ModelAreaScore`** (aggregate rows) — retained, but demoted to what it
   really is: Grade B/E prior evidence for models/areas with no per-task
   coverage, and the input to the *shortlisting* stage only.

`ModelAreaMatrix` becomes a **derived, versioned rollup** of 1+2+5 (the PR's
README already promises exactly this: "task catalog first, task outcomes
second, and model-area summaries as derived rollups only" — the code should
be made to match its own README).

### 5.3 Taxonomy v1 (pruned to what data can support)

Adopt the plan's axes, cut to the subset public data can populate and that
plausibly changes panel/routing decisions:

```
primary_domain (8):
  repo_bugfix | algorithmic | frontend_ui | backend_api_db |
  data_sql | devops_terminal | refactor_migration | security

task_operation (6):
  greenfield | feature_add | bugfix_debug | refactor |
  test_generation | optimization

language (9 + escape):
  python | typescript_js | sql | shell | go | rust | java | cpp |
  polyglot | other

context_shape (5 boolean flags):
  single_file | multi_file_repo | long_context | tool_required |
  browser_or_visual
```

Deferred: `quality_axis` (public per-task data almost never distinguishes
correctness from maintainability/security axes; add when calibrated data
exists), `systems_performance` as a domain (fold into
`algorithmic + optimization` until a source provides per-task perf data),
`mobile_native`/`ml_engineering`.

Source-to-taxonomy mapping is a declared, versioned artifact (plan §8 Step 2)
enforced by the existing `SOURCE_AREAS` advertising + `DataQualityReport`
mismatch check — a source emitting labels it did not declare is a data-quality
error, exactly as PR #52 already treats undeclared areas.

**Label lifecycle (the plan's §10 acid test, made operational).** A label
survives into v2 only if, on the mined per-task matrix, it changes decisions:
for some model pair (with ≥ 100 common tasks on each side of the split), the
sign of the pass-rate difference flips across the label, or the top-K panel
selected within the label differs from the global panel with bootstrap
stability ≥ 80%. Labels that never change a decision are merged away. This
runs on public data at n=thousands — resolving the plan's power contradiction
(§2.2(1)) *before* any calibration money is spent.

### 5.4 Evidence tiers unified

Map the plan's grades onto PR #52's `data_level` and make the usage policy
executable:

| Plan grade | `data_level` | `scaffold_confounded` | May influence |
|---|---|---|---|
| A | `task_outcome` (+ artifacts) | false | Complementarity, panel selection, router priors, judge training |
| A− | `task_outcome` | true | Same, but reported as *system*-level; never attributed to raw model without a matching calibrated check |
| B | `subtask_score` | any | Capability priors at reduced weight; shortlisting |
| C | `PairwisePreference` | — | Judge/reranker training only |
| D | `task_metadata_only` | — | Task selection, coverage analysis only |
| E | `aggregate_score` | any | Shortlisting only |
| Calibrated | `same_run_task_outcome` | false | Everything, including rubric claims |

The gate becomes code: panel *cards* (§5.9) list, per claim, the minimum tier
backing it; `recommend_panel` already refuses task-evidence scores below
`task_vector` — extend the same pattern so complementarity numbers on a card
cannot be emitted from tiers below A/A−.

### 5.5 Scoring and statistics

Replace min–max + multiplied heuristics with three standard tools:

**(a) Within-cohort standardization with anchor linking.** Within a
(benchmark, version, area, harness) cohort of ≥ 8 models, use z-scores
(`z = (s − μ)/σ`); for smaller cohorts, use rank quantiles. To place two
benchmarks' cohorts on one area scale, fit the additive linking model

```
s_{m,b} = μ_b + θ_m + ε        (least squares over observed (model, benchmark) pairs)
```

where `θ_m` is the model's area ability and `μ_b` the benchmark's offset.
This is identifiable exactly when the model-benchmark overlap graph is
connected — which is also the *honest* condition for cross-benchmark
comparison: if no models are shared, refuse to merge scales and keep
benchmark-level columns (with the existing "single-source cell" warning).
Min–max survives only as a display transform, never as an input to selection.

**(b) Uncertainty as intervals, not vibes.** For pass-rate-like cells with
known `n_tasks`: Wilson intervals,

```
p̃ = (p̂ + z²/2n) / (1 + z²/n)   ± half-width from the standard Wilson formula
```

and empirical-Bayes shrinkage toward the area mean via a beta-binomial fit
(method of moments over the cell population): `p_shrunk = (x + α)/(n + α + β)`.
`AreaMatrixCell.confidence` is replaced by `interval_low/interval_high`;
selection consumes `p_shrunk` and interval width. Cells without `n_tasks`
inherit a wide fixed interval (this preserves and sharpens PR #52's
"missing task counts" data-quality check).

**(c) Paired comparisons everywhere two models share tasks.** McNemar on
discordant pairs (`χ² = (b−c)²/(b+c)`) for A-vs-B claims; bootstrap CIs for
oracle-gain estimates. All of this exists in `fusionkit_evals.prompt_tuning`
for Layer 2 and should be reused, not reimplemented, for the mined public
matrices.

Retain the PR's `DATA_LEVEL_WEIGHTS`/`SCORING_WEIGHTS` only as *prior
precision* modifiers (they widen intervals rather than silently scaling
point estimates), and delete the free-floating
contamination/saturation/freshness multipliers in favor of mechanisms:
LiveCodeBench date-windowing (only post-model-release windows count as
uncontaminated for that model), a saturation flag when the top-quartile
models of an area are within one interval width of each other, and freshness
as `date_observed` recency entering the prior precision.

### 5.6 Complementarity and top-K selection

This is the core upgrade both artifacts need. Definitions over the per-task
outcome matrix `y_{m,t} ∈ {0,1}` (or [0,1]) within one comparable group:

```
pass(m)         = mean_t y_{m,t}
oracle(S)       = mean_t max_{m∈S} y_{m,t}            # coverage of subset S
headroom(S)     = oracle(S) − max_{m∈S} pass(m)
unique_win(m|S) = mean_t [ y_{m,t}=1 and y_{m',t}=0 ∀ m'∈S\{m} ]
φ(m,m')         = phi coefficient of failure indicators (n ≥ 30 common tasks;
                  bootstrap CI; refuse otherwise)
```

**Judge realizability.** A judged ensemble does not collect the oracle.
Estimate a per-subdomain capture rate from Layer 2:

```
capture(d) = judged_ensemble_success(d) / oracle_success(d)     # measured
```

with a conservative prior (≈ 0.6–0.8, consistent with this repo's
judge-synthesis-regret measurements in `fusion_bench`) until measured. The
expected value of a panel is then

```
V(S, d) = pass_best(S, d) + capture(d) · headroom(S, d) − λ·cost(S) − μ·latency(S)
```

**Selection.** `oracle(S)` is monotone submodular in S, so greedy selection
by marginal gain enjoys the (1 − 1/e) guarantee; use lazy greedy with the
constraints PR #52 already implements (provider diversity, cost cap) plus one
new hard constraint from the identity facets: **at most one variant per
`base_model_key`** (no panels of three reasoning-effort variants of the same
engine — currently expressible but not enforced in PR #52).

**Fallback ladder (explicit, labeled).** Where no Grade A/A− task outcomes
exist for a candidate: fall back to PR #52's capability-vector similarity
penalty, with two fixes — cosine computed only over *jointly observed* areas
(≥ 3 required, else neutral 0.5 + warning) instead of 0-imputation, and the
resulting members labeled `aggregate proxy diversity` exactly as today. The
card must show which members were selected under which rung of the ladder.

**Reported per panel member** (feeds the card, §5.9): capability per profile
area with interval; leave-one-out marginal value `V(S) − V(S\{m})`; unique-win
rate; max pairwise φ against other members (rubric §2.2 threshold: no pair
above ~0.7 on the target task class); evidence tier per number.

### 5.7 Calibration loop (Layer 2, using existing machinery)

1. **Select tasks by informativeness** (plan §34 formula, from §2.1(d)), with
   two amendments: weights are subject to a stability check (selection must
   be ≥ 80% stable under ±50% weight perturbation), and `disagreement` is
   computed from the *mined* per-task matrix restricted to shortlisted
   candidates (not all public models — disagreement among models you'd never
   deploy is noise). Target 150–440 tasks across the 4 densest domains.
2. **Run the shortlisted panel** through the existing stack:
   `fusion_bench` → `candidate_bank.CandidateBank` (frozen per-task pass
   flags) → `fusion_hillclimb.diagnose_bank` (oracle ceiling, best single,
   mean failure correlation, lopsidedness) → judge/synthesis with regret
   measurement. Apples-to-apples invariants come from the plan's §35
   checklist; most are already satisfied by running everything through one
   harness, and the manifest (§35.16) should be emitted with the bench
   report per the rubric's no-corner-cutting rule.
3. **Feed back**: convert `CandidateBank` per-task flags into
   `same_run_task_outcome` rows (an adapter of a few dozen lines — the top
   evidence tier finally gets a producer). Note the naming collision to
   handle in code: `fusionkit_evals` already has a `TaskOutcome` *Literal*
   ("scored"/"model_failed"/...) unrelated to the index's `TaskOutcome`
   row model; the adapter should alias imports accordingly.
4. **Score the index itself** (§5.8) before trusting it further.

### 5.8 Index self-validation (the number that governs trust)

After each calibration round, compute and publish:

- **Ranking fidelity:** Spearman ρ between index-predicted per-subdomain
  model ranking and the calibrated ranking. Target ≥ 0.7 before index
  rankings may seed default panels without human review.
- **Probability calibration:** Brier score of predicted P(pass) per
  model×subdomain against calibrated outcomes.
- **Complementarity fidelity:** error of predicted `headroom(S)` vs measured
  oracle headroom on the calibration bank, and sign agreement of predicted vs
  measured pairwise φ.
- **Prior→posterior deltas:** which sources' priors moved most when
  calibrated evidence arrived — the empirical basis for adjusting per-source
  prior precision (replacing hand-set weights with measured ones over time).

This closes the loop the plan gestures at and PR #52 lacks entirely: the
index earns (or loses) influence based on measured predictive value.

### 5.9 The product artifact: per-subdomain panel cards

A versioned JSON/markdown pair per subdomain, generated from the warehouse:

```yaml
panel_card:
  card_id: repo_bugfix.python.v3
  subdomain: {primary_domain: repo_bugfix, language: python}
  generated_from: {index_snapshot: sha256:…, calibration_bank: bank-2026-07-…}
  panel:
    - model: base_model_key=…, provider=…, reasoning_effort=…
      role: generator
      strengths: [{area: repo_bugfix, p: 0.61, interval: [0.55,0.67], tier: A-}]
      marginal_value: +0.09        # V(S) − V(S \ {m})
      unique_win_rate: 0.12
      max_pairwise_failure_phi: 0.41
    - …
  judge: {model: …, capture_rate: 0.74, tier: calibrated}
  expected: {panel_success: 0.71, best_single: 0.63, oracle: 0.78,
             cost_per_task_usd: …, latency_s: …}
  evidence_floor: A-               # weakest tier backing any number above
  warnings: [ "frontend coverage aggregate-proxy only", … ]
  refresh: {trigger: "new model in shortlist OR index snapshot > 60d old"}
```

The card is the deliverable the product brief asks for ("each ensemble
presented with a clear explanation of why those models were selected, what
each is individually strong at, and what complementarity they provide") —
PR #52's `PanelRecommendationMember.reason` grown into a first-class,
evidence-floored artifact. Cards also emit machine-readable
`benchmark_panel.BenchmarkPanel` presets so Layer 2 can consume them
directly (and `BENCHMARK_PANEL_PRESETS` in `fusionkit_core.registry` can be
generated rather than hand-maintained).

### 5.10 Router staging

Exactly per the plan, resisting the temptation to skip stage 1:

1. **Rule-based router from cards** — per subdomain: specialist-single when
   one model dominates (`pass_best − pass_second > LOPSIDED_SCORE_GAP` and
   headroom < judge overhead), cheap-first-then-escalate when a cheap model's
   calibrated pass rate exceeds a threshold, full panel+judge when headroom ×
   capture exceeds the marginal cost. Transparent, debuggable, needs no
   training data.
2. **Learned router** only after Layer-2 data accumulates. Features:
   taxonomy labels + prompt embeddings + repo metadata + tool requirements.
   Hard leakage rules from plan §35.15: never `source_name`, never
   benchmark IDs, never public outcome labels for the same task. Validation:
   in-domain, cross-source, and future holdouts — non-negotiable given that
   Layer-1 priors are contaminated by construction.
3. **Router regret** (`oracle_best_route − router_route`) as the tracked
   metric, with `unnecessary_ensemble_rate` and
   `missed_ensemble_opportunity_rate` as the two decomposition terms.

### 5.11 Refresh playbook (the index as a living artifact)

Trigger: new frontier model ships, or an index snapshot exceeds staleness
bounds, or Layer-3 telemetry drifts from card expectations.

```
re-mine sources (new model rows) → identity resolution → shortlist delta
→ if shortlist changed: informativeness-select a delta calibration slice
  (only tasks that discriminate the new model vs incumbents — typically
  50–150 tasks, not a full re-run)
→ candidate_bank re-freeze → diagnose → re-select panel → re-issue cards
→ rubric §9.5 evidence artifact
```

This is the operational answer to §2.2(3): campaign phases become a standing
pipeline with a delta-cost per refresh, which is what makes "precomputed
ensembles" a product rather than a one-off report.

---

## 6. Source-by-source mining plan (Layer 1 ingestion)

Ordered by information value per effort. "Volume" is order-of-magnitude
task-outcome rows obtainable.

| # | Source | Per-instance? | Tier | Volume | Extract | Key caveat |
|---|---|---|---|---|---|---|
| 1 | SWE-bench experiments (github.com/swe-bench/experiments) | Yes: per-instance resolved/unresolved + patches + logs per submission | A− | 10⁴–10⁵ | `TaskOutcome(model_key=submission, harness_or_agent=scaffold, scaffold_confounded=True)`; patches → `ModelAnswerArtifact` | Rows measure model+scaffold systems; complementarity is system-level until calibrated |
| 2 | LiveCodeBench per-question (already parsed by PR #52) | Yes: question × model × pass@1, official harness | A | 10⁴ | Stop aggregating: emit `TaskOutcome` per question; keep `subtask_score` rollups for the matrix; date-window per model release for contamination | Scenario coverage varies by model; enforce common-task intersections |
| 3 | LiveBench per-question (HF dataset server; already parsed) | Yes: question × model × score + category | A | 10⁴ | Same promotion as LCB; categories map to taxonomy (reasoning/data_analysis/coding) | LLM-judged categories carry `scoring=llm_judge` → wider priors |
| 4 | BigCodeBench pre-generated samples + results | Yes: 1,140 tasks × many models, pass/fail under official harness | A | 10⁴–10⁵ | `TaskOutcome` + library labels (pandas/numpy/requests/…) → `language=python`, domain `backend_api_db`/`data_sql`/`algorithmic` per task | Function-level only; no repo/frontend signal |
| 5 | LLMRouterBench (33 models, 21+ datasets, 400K+ instances) | Yes | A/B | 10⁵ | Bulk `TaskOutcome` for its coding subsets; the reference dataset for validating top-K selection math offline | Mixed harnesses across datasets — group strictly; model list may lag frontier |
| 6 | Terminal-Bench trajectories | Yes, incl. step traces | A− | 10³ | Outcomes + derived tool-use features (failed/repeated commands, timeouts) → devops_terminal priors and difficulty features | Full agent systems; strongly scaffold-confounded |
| 7 | Aider polyglot, Open LLM Leaderboard, BenchLM, Artificial Analysis | No (aggregates) | E/B | — | Keep as today (`ModelAreaScore`): shortlisting + coverage for models lacking per-task rows | AA needs API key + license review for redistribution |
| 8 | DS-1000 / Spider 2.0 / Design2Code metadata | Labels only | D | 10³ tasks | `BenchmarkTask` registry rows for coverage + future calibration selection | No outcomes → never influences rankings |
| 9 | WebDev Arena preferences (10k pairs) | Pairwise | C | 10⁴ pairs | `PairwisePreference` for judge training only | License review before any redistribution; never enters capability matrix |
| 10 | RouterBench | Yes (405K outcomes) | B | 10⁵ | Router-baseline replication harness; secondary outcome source | Older model pool; broad rather than coding-deep |

Items 1–4 alone convert the index's complementarity story from proxy to
Grade A/A− evidence across four subdomains (repo_bugfix, algorithmic,
data/library coding, terminal/devops) at zero run cost — the single
highest-leverage action available.

---

## 7. Gap analysis: concrete changes to PR #52

File-level, ordered by impact:

1. **Promote per-question parsers** (`core.py` LCB ×4 + LiveBench): emit
   `TaskOutcome` rows alongside the existing `subtask_score` aggregates;
   plumb a `fetch_live_task_outcomes()` entry point + `--write-task-outcomes`
   CLI flag mirroring the existing task-catalog path.
2. **New `SourceSpec`s**: `swebench_experiments`, `bigcodebench_samples`,
   `llmrouterbench`, `terminal_bench_trajectories` (per §6). These are bulk
   dataset downloads, not HTML scrapes — *more* stable than the existing
   sources.
3. **Replace `_normalized_scores`** min–max with cohort z-scores / rank
   quantiles + anchor linking (§5.5a); keep min–max as display-only.
4. **Replace cell `confidence`** with Wilson/shrinkage intervals (§5.5b);
   demote `DATA_LEVEL_WEIGHTS`/`SCORING_WEIGHTS` to prior-precision
   modifiers; delete inert contamination/saturation/freshness multipliers in
   favor of the three concrete mechanisms (date-windowing, saturation flag,
   recency-weighted precision).
5. **Rebuild `recommend_panel`** as two stages: (i) eligibility shortlist
   from capability intervals per profile; (ii) lazy-greedy oracle-gain
   selection over `TaskOutcome` groups with judge-capture discount, cost
   term, provider-diversity and **one-variant-per-`base_model_key`**
   constraints; similarity-proxy fallback ladder with per-member tier labels
   (§5.6).
6. **Fix `_candidate_diversity_score`**: cosine over jointly observed areas
   only (≥ 3 required, else 0.5 + warning); never 0-impute missing cells.
7. **Split `core.py`** (2,851 lines) into `models.py`, `sources/…`,
   `normalize.py`, `outcomes.py`, `recommend.py`, `quality.py`; add
   golden-snapshot regression tests (recorded real payloads, not only
   synthetic fixtures) to catch semantic parser drift.
8. **Add the `CandidateBank → same_run_task_outcome` adapter** and the panel
   card emitter (§5.7(3), §5.9), including `BenchmarkPanel` preset output.
9. **License as a hard field** with a `DataQualityReport` check: rows whose
   license forbids redistribution can be used for internal selection but are
   stripped from any exported card/snapshot (§9).

Everything else in the PR — registry, provenance, tolerant/strict fetch,
data-quality machinery, identity facets, strict grouping guard, artifact
hygiene — is kept as-is.

---

## 8. Integration points with this repo

- `fusionkit_evals.candidate_bank.CandidateBank` → the Layer-2 producer of
  `same_run_task_outcome` rows (per-candidate pass flags already exist; see
  `fusion_hillclimb.BestSingle.pass_map`).
- `fusionkit_evals.fusion_hillclimb.diagnose_bank` → the validator for index
  predictions (oracle ceiling, best single, mean failure correlation,
  lopsidedness map 1:1 to card fields).
- `fusionkit_evals.benchmark_panel` → consumes generated `BenchmarkPanel`
  presets; its hand-rolled headroom estimator is superseded by index-backed
  numbers but its lopsidedness gate (`LOPSIDED_SCORE_GAP`) survives as a
  card-level warning.
- `fusionkit_evals.prompt_tuning.mcnemar` + Wilson helpers → reused for
  paired stats on mined public matrices (no reimplementation).
- `docs/fusion/FUSION_VALUE_RUBRIC.md` §2.2 (decorrelation feeds panel
  selection; pairwise failure correlation ≤ ~0.7) and §9.5 (pool-refresh
  playbook) → directly satisfied by §5.6 and §5.11.
- Naming collision to resolve in code: `fusionkit_evals` defines
  `TaskOutcome` as a run-classification `Literal`; the index defines
  `TaskOutcome` as a row model. Alias on import (`IndexTaskOutcome`) or
  rename in one package before wiring them together.

---

## 9. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Contamination**: public tasks in training data inflate priors | High | Layer separation (priors never back claims); LCB/LiveBench date-windowing; §5.8 fidelity metrics detect systematic inflation; calibration slices favor post-cutoff tasks |
| **Scaffold confound**: SWE-bench/Terminal-Bench rows measure systems | High | `scaffold_confounded` flag; A− tier; complementarity from confounded rows reported as system-level; calibrated runs attribute to raw models |
| **Identity aliasing**: same engine counted as multiple "diverse" models | Medium | PR #52 facets + the new one-variant-per-`base_model_key` selection constraint; alias table grows with manual review queue |
| **Parser drift**: silent semantic corruption of scraped sources | Medium | Golden-snapshot regression tests; `DataQualityReport` distribution checks (sudden rank churn vs prior snapshot flags the source); prefer bulk dataset sources (§6 items 1–5) over HTML |
| **License leakage**: restricted rows exported in cards/snapshots | Medium | Hard license field + export-time strip + data-quality error (§7 item 9) |
| **Simpson's paradox** in cross-slice aggregation (difficulty mix differs per model) | Medium | Common-task intersections for all pairwise/oracle math (already enforced by the strict grouping guard); rollups report slice composition |
| **Hand-set weight arbitrariness** (profiles, informativeness) | Medium | Sensitivity checks (§5.7(1)); §5.8 prior→posterior deltas gradually replace hand weights with measured precision |
| **Judge over-credit**: oracle headroom rewarded as if fully captured | Medium | Capture-rate discount, conservative prior until measured (§5.6) |
| **Cell sparsity** in fine taxonomy intersections | Medium | Label lifecycle test on public data before calibration spend (§5.3); shrinkage + intervals make sparse cells visibly uncertain |
| **Index ossification**: cards go stale as models ship | Low | Refresh playbook with delta-calibration (§5.11); staleness triggers |

---

## 10. Prioritized roadmap (acceptance criteria, no calendar time)

**M1 — Task-outcome spine.** Promote LCB/LiveBench per-question rows; ingest
SWE-bench experiments + BigCodeBench samples.
*Accept:* ≥ 10⁴ `TaskOutcome` rows across ≥ 3 subdomains; strict-group
correlation matrices computable for ≥ 10 current models; all rows pass
`DataQualityReport` with zero errors.

**M2 — Taxonomy mapping + label lifecycle.** Multi-axis labels over the
warehouse; run the §5.3 split/merge test on mined data.
*Accept:* every retained label demonstrably changes a ranking or panel for
some model pair at n ≥ 100; a published v1 source-to-taxonomy map.

**M3 — Selection + statistics upgrade.** §5.5 normalization/intervals;
§5.6 top-K greedy with capture discount and identity constraint.
*Accept:* on LLMRouterBench held-out coding subsets, greedy-selected panels'
measured oracle gain ≥ 90% of exhaustive-search optimum for K ≤ 3; selection
stable under bootstrap resampling of tasks (≥ 80% member agreement).

**M4 — First panel cards.** Cards for the 3–4 densest subdomains
(repo_bugfix, algorithmic, data/library, terminal/devops).
*Accept:* every card number carries a tier and interval; evidence floor
≥ A− for complementarity claims; cards emit valid `BenchmarkPanel` presets.

**M5 — Calibration + self-validation.** Informativeness-selected slice
(150–440 tasks) through `fusion_bench`/`candidate_bank`/`diagnose_bank`;
feedback adapter; §5.8 metrics.
*Accept:* Spearman ρ(index, calibrated) reported per subdomain; measured
judge capture rate replaces the prior; `same_run_task_outcome` rows present
in the warehouse; rubric §2.2 evidence artifact produced.

**M6 — Rule-based router + refresh drill.** Card-driven routing rules;
execute one full refresh cycle on a newly shipped model.
*Accept:* router regret and unnecessary-ensemble/missed-opportunity rates
reported on a held-out slice; refresh completed with delta-calibration only
(≤ 150 tasks), satisfying rubric §9.5.

---

## Appendix A — formulas

```
Wilson interval (binary pass rate, confidence z):
  center = (p̂ + z²/2n) / (1 + z²/n)
  half   = z/(1 + z²/n) · sqrt( p̂(1−p̂)/n + z²/4n² )

Beta-binomial shrinkage (method-of-moments α, β over cell population):
  p_shrunk = (x + α) / (n + α + β)

Anchor linking across benchmarks within an area:
  minimize Σ_(m,b) (s_{m,b} − μ_b − θ_m)²   over observed pairs;
  identifiable iff the model–benchmark bipartite overlap graph is connected.

Failure correlation (φ over failure indicators f = 1−y):
  φ = (n11·n00 − n10·n01) / sqrt(n1•·n0•·n•1·n•0),  require n ≥ 30 common tasks.

Oracle coverage and headroom for subset S:
  oracle(S)   = mean_t max_{m∈S} y_{m,t}      (monotone submodular in S)
  headroom(S) = oracle(S) − max_{m∈S} pass(m)

Panel value with judge capture and budgets:
  V(S,d) = pass_best(S,d) + capture(d)·headroom(S,d) − λ·cost(S) − μ·latency(S)
  capture(d) = judged_ensemble_success(d) / oracle_success(d)   (Layer 2)

Greedy guarantee: lazy greedy on monotone submodular oracle(S) under a
cardinality constraint achieves ≥ (1 − 1/e) of optimum.

McNemar (paired A vs B; b, c = discordant counts):
  χ² = (b − c)² / (b + c)

Task informativeness (calibration selection; plan §34, stability-checked):
  score = 0.30·disagreement + 0.20·entropy + 0.20·undercoverage
        + 0.15·expected_complementarity + 0.10·traffic_relevance
        − 0.10·runtime − 0.15·flakiness − 0.20·license_risk
```

## Appendix B — glossary deltas vs the two artifacts

- **Index (this report):** versioned warehouse + derived rollups + panel
  cards; the product artifact. Not a benchmark campaign (plan) and not a
  matrix CLI (PR #52).
- **Tier A− (new):** per-instance same-harness public outcome that is
  scaffold-confounded (SWE-bench submissions, Terminal-Bench trajectories).
  Valid for system-level complementarity; requires calibration for raw-model
  attribution.
- **Capture rate (new):** fraction of oracle headroom a judged ensemble
  realizes; measured per subdomain in Layer 2; discounts all Layer-1
  headroom rewards.
- **Label lifecycle (new):** the plan's "a label is useful only if it changes
  routing decisions", made an executable retention test on mined data.
- **Evidence floor (new):** the weakest tier backing any number on a panel
  card; cards refuse to print complementarity claims below A−.
