# Coding Capability Index — Implementation Specification

**Status:** Phase 0 executed 2026-07-04 — **build the reduced scope only**
(see the addendum below and `phase0-validation-report.md`)
**Audience:** an engineer with no prior context on this project
**Deliverable:** a Python workspace package (`capability-index`) plus
integration glue into the existing `fusionkit-evals` benchmark stack

---

## ⚠ Post-validation addendum (read before implementing)

The §19 Phase-0 validation study was executed (all four checkpoints, plus
two follow-up experiments; full results in
`docs/fusion/phase0-validation-report.md`, program history in
`docs/fusion/capability-index-program.md`). The verdicts bind this spec:

| Checkpoint | Result | Consequence for this spec |
|---|---|---|
| C0 coverage | PARTIAL | Sources S2/S5/S6 confirmed viable; S1 unproven; frontier coverage is A−/variant-level |
| C1 existence | PASS | Complementarity math (§11.3) validated on real data |
| C2 selection value | **FAIL — settled** (incl. V-objective re-test) | **§11.4's public-prior panel *ranking* paths are cancelled.** Public data retains shortlist-and-veto authority only |
| C3 transfer | PASS revised | Sign transfer 10/10 held; headroom evidence was a truncation artifact; the tested slice is lopsided |

Binding scope changes:

1. **Build the reduced index**: warehouse core (§5–§10, §13), shortlist +
   pair-veto analytics, evidence-report cards only. Panel *selection*
   authority lives exclusively in the calibration loop (§15), which is
   promoted from validator to primary engine.
2. **Cancel/defer**: greedy/exhaustive public-prior panel ranking (§11.4
   beyond veto duty), aggregate-proxy diversity fallback, S1/S9 ingestion,
   the learned router (§16 stage 2).
3. **New measurement requirements** learned from the truncation incident:
   any calibration run MUST record completion-budget truncation per row and
   refuse pass-rate claims for models whose truncation rate exceeds ~10%;
   thinking models need ≥16k (often ≥32k) completion budgets.
4. The first calibration round targets **agentic/repo tasks and
   synthesis-style fusion**, not single-shot algorithmic slices (that
   routing question is answered: lopsided → don't fuse).

The remainder of the document is preserved as written (including the parts
now descoped) as the reference design; implementers follow the addendum
where they conflict.

---

## Part I — What we are building and why

### 1. The product goal

We ship a model-fusion product: instead of sending a coding task to one LLM,
we send it to a **panel** of generator models, then a **judge/synthesizer**
model selects or fuses the best answer. Fusion only pays off when the panel
members fail on *different* tasks — if every member fails on the same tasks,
the panel is expensive redundancy.

This creates three recurring questions that today we answer by intuition:

1. **Which models are strong in which coding subdomains?** (e.g. who is best
   at repo-level bug fixing vs. SQL vs. frontend visual work)
2. **Which models make complementary errors?** (whose failure sets overlap
   least, so that a panel of them has a high ceiling)
3. **Which top-K models should form the panel for a given subdomain**, and
   when should a router send a task to one model vs. the full panel?

The system specified here answers those questions with data. It is a
**capability index**, not a benchmark:

- A *benchmark* measures performance on one fixed task set under one harness.
  Its output is a score.
- An *index* aggregates evidence from many benchmarks into per-model,
  per-subdomain beliefs with explicit confidence and provenance. Its output
  is a prior you can act on.

The core design constraint: **running every benchmark ourselves is too slow
and too expensive.** Public benchmark ecosystems have already spent millions
of GPU-hours producing per-task results, model outputs, patches, and logs. We
mine that, and spend our own run budget only where it buys the most
information.

The central hypothesis the index must operationalize:

> The best ensembles are not built from the models with the highest average
> scores. They are built from models that are strong in different coding
> subdomains and exhibit complementary error patterns.

### 2. The fundamental unit: the task

Everything in this system is keyed on the **task** — one concrete problem
instance from some benchmark (one SWE-bench issue, one LiveCodeBench
question, one terminal scenario). A task carries metadata: domain, subdomain,
operation type, language, framework, difficulty, and pointers to artifacts.
Model performance attaches to tasks as **outcome rows** (model M
passed/failed task T under harness H).

This matters because complementarity is a *per-task* property. Two models
with identical 60% aggregate pass rates could fail on the same 40% of tasks
(panel ceiling: 60%, fusion worthless) or on disjoint 40%s (panel ceiling:
100%, fusion transformative). Aggregate leaderboard scores cannot distinguish
these cases. Per-task outcome matrices can.

### 3. The three-layer evidence architecture

All evidence lives in exactly one of three layers, and the layers have
different rights:

```
Layer 1 — PUBLIC PRIOR INDEX (no-run, cheap, refreshable)
  Mined from public benchmarks: task catalogs, per-task outcomes, aggregate
  scores, model outputs/patches/logs, pairwise preferences.
  MAY drive: model shortlisting, candidate panel composition, selection of
  which tasks to run ourselves, router pretraining features.
  MAY NEVER: back a public performance claim or a production routing
  decision on its own.

Layer 2 — CALIBRATED RUNS (billed, small, decisive)
  Our own runs: the exact shortlisted models, under one identical harness,
  on a deliberately chosen task slice, with full cost/latency capture.
  MAY drive: final panel composition, judge choice, router training,
  public claims.

Layer 3 — PRODUCTION TELEMETRY (free, continuous, noisy)
  Live gateway logs: per-request model, cost, latency, downstream signals.
  MAY drive: cost/latency estimates, drift alarms, index refresh triggers.
```

The governing rule, stated once and enforced everywhere:

> **Public results tell you where to look. Calibrated runs tell you what is
> true. Production telemetry tells you when to look again.**

Reports and artifacts never mix layers in one table. Every stored row carries
its layer.

### 4. Why public data must be tiered, not trusted

Public benchmark data is heterogeneous in a way that silently corrupts naive
aggregation:

- **Scaffold confounding.** A SWE-bench leaderboard entry measures *model +
  agent scaffold + prompt + tool budget*, not a raw model. Two entries for
  "the same model" under different scaffolds can differ by 20 points.
- **Harness variance.** pass@1 under one sandbox ≠ pass@1 under another.
- **Contamination.** Public tasks leak into training data; older tasks
  overstate newer models.
- **Identity aliasing.** `gpt-5`, `gpt-5 (high)`, `GPT-5 via Codex CLI` are
  one engine at different settings; treating them as three independent
  models corrupts diversity math.
- **Grading mode.** Deterministic tests ≠ LLM-judged scores ≠ human
  preference votes.

The defense is an **evidence tier** attached to every row, with a hard usage
policy per tier:

| Tier | Data shape | May influence |
|---|---|---|
| **A** | Per-task outcome, same harness for all models in the group, not scaffold-confounded | Complementarity math, panel selection, router priors |
| **A−** | Per-task outcome, same harness, but scaffold-confounded (measures model+agent systems) | Same as A, but results labeled *system-level*; raw-model attribution requires Layer-2 confirmation |
| **B** | Per-task or sliced scores under mixed/unknown harnesses | Capability priors at reduced weight; shortlisting |
| **C** | Pairwise human preference votes | Judge/reranker training only |
| **D** | Task labels/metadata only (no outcomes) | Task selection and coverage analysis only |
| **E** | Aggregate leaderboard numbers | Model shortlisting only |
| **CAL** | Our own Layer-2 outcomes | Everything, including public claims |

These tiers are encoded in the schema (§7) and enforced by validation code
(§13), not by reviewer discipline.

---

## Part II — System specification

### 5. Architecture overview

```
                    ┌─────────────────────────────────────────────┐
                    │ Layer 1: capability-index package           │
                    │                                             │
  public sources ──▶│ sources/   (connector registry + parsers)   │
                    │      │                                      │
                    │      ▼                                      │
                    │ warehouse    (BenchmarkTask, TaskOutcome,   │
                    │               AggregateScore, artifacts)    │
                    │      │                                      │
                    │      ├──▶ quality.py   (DataQualityReport)  │
                    │      ├──▶ taxonomy.py  (label mapping)      │
                    │      ▼                                      │
                    │ analytics    (normalize, intervals,         │
                    │               complementarity, top-K)       │
                    │      │                                      │
                    │      ▼                                      │
                    │ panel cards  (versioned product artifact)   │
                    └──────┬──────────────────────────────────────┘
                           │ emits BenchmarkPanel presets +
                           │ calibration task slices
                           ▼
                    ┌─────────────────────────────────────────────┐
                    │ Layer 2: fusionkit-evals (exists today)     │
                    │ fusion_bench → CandidateBank →              │
                    │ diagnose_bank / McNemar / regret            │
                    └──────┬──────────────────────────────────────┘
                           │ per-task pass flags fed back as
                           │ tier-CAL TaskOutcome rows
                           ▼
                    index self-validation (§12) → refreshed cards
```

The new code is one Python package in the uv workspace:
`python/capability-index/`, importable as `capability_index`, with a CLI
entry point. It depends only on `pydantic` (and stdlib `urllib`/`json`/`csv`)
for Layer 1; the Layer-2 bridge additionally imports `fusionkit_evals`.

Existing repo assets to reuse rather than rebuild (all under
`python/fusionkit-evals/src/fusionkit_evals/`):

- `candidate_bank.py` — `CandidateBank`: frozen per-task, per-model pass
  flags from our own benchmark runs. This is the Layer-2 ground-truth store.
- `fusion_hillclimb.py` — `diagnose_bank()`: oracle ceiling, best single
  model, mean failure correlation on a bank.
- `fusion_compound.py` — `compare_compound_vs_individual()`: paired
  fused-vs-best-single comparison with McNemar.
- `prompt_tuning.py` — `mcnemar()` and interval helpers.
- `benchmark_panel.py` — `BenchmarkPanel` model (panel presets consumed by
  the bench runner); the index will *generate* these.
- `public_bench.py` / `fusion_bench.py` — the run harness for Layer 2.

### 6. Package layout

```
python/capability-index/
  pyproject.toml                 # name = "capability-index", deps: pydantic>=2
  README.md
  fixtures/                      # small reviewed sample rows (committed)
    task_outcomes.sample.jsonl
    aggregate_scores.sample.jsonl
  snapshots/                     # small, license-cleared, redacted excerpts
    swebench_experiments.2026-07.sample/       # (full snapshots live in
    llmrouterbench.2026-07.sample/             #  object storage, §9.2 notes)
  src/capability_index/
    __init__.py                  # public API re-exports
    __main__.py
    cli.py
    models.py                    # all pydantic schemas (§7)
    taxonomy.py                  # label enums + source→taxonomy maps (§8)
    registry.py                  # SourceSpec registry (§9.1)
    connectors.py                # http/git-tree/release/hf/s3 connectors (§9.1)
    sources/
      __init__.py
      swebench_experiments.py    # per-instance outcomes (tier A−)
      llmrouterbench.py          # bulk instance outcomes (tier A/B)
      livebench.py               # per-question outcomes (tier A)
      bigcodebench.py            # per-sample outcomes (tier A)
      terminal_bench.py          # per-trial outcomes (tier A−)
      livecodebench.py           # per-question outcomes (tier A, once proven)
      aggregates.py              # Aider/OpenLLM/BenchLM/AA (tier E/B)
      preferences.py             # WebDev-Arena-style pairs (tier C, gated)
    identity.py                  # model identity resolution (§10)
    normalize.py                 # z-scores, anchor linking, intervals (§11.1–11.2)
    outcomes.py                  # outcome matrices, φ, oracle, headroom (§11.3)
    select.py                    # top-K greedy panel selection (§11.4)
    quality.py                   # DataQualityReport (§13)
    cards.py                     # panel card generation (§14)
    calibration.py               # informativeness selection + Layer-2 bridge (§15)
    validate.py                  # index self-validation metrics (§12)
tests/
  test_capability_index_models.py
  test_capability_index_sources.py     # golden-snapshot parser tests
  test_capability_index_outcomes.py
  test_capability_index_select.py
  test_capability_index_cards.py
```

Register the package in the root `pyproject.toml` workspace `include` list
and in `uv.lock` via `uv sync --all-packages`. Lint/type gates are the repo
defaults: `uv run ruff check .`, `uv run pyright`, `uv run pytest tests -q`.

### 7. Data model

All schemas are pydantic v2 models. JSONL is the storage format (one row per
line); every table is an append-only log with snapshot semantics — a
"snapshot" is a JSONL file plus its SHA-256, and derived artifacts record the
snapshot hashes they were built from.

```python
# src/capability_index/models.py
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

EvidenceTier = Literal["A", "A-", "B", "C", "D", "E", "CAL"]
Layer = Literal["public_prior", "calibrated", "production"]
ScoringMode = Literal[
    "deterministic_tests",   # hidden unit/integration tests, exact execution
    "objective",             # exact-match / programmatic, not test-suite
    "llm_judge",             # scored by a model
    "human_preference",      # arena-style votes
]
ScoreDirection = Literal["higher_is_better", "lower_is_better"]


class LicenseRights(BaseModel):
    """Per-right license model. A coarse enum is not enough: gated datasets
    (e.g. WebDev Arena) prohibit transfer/hosting, API terms (e.g. Artificial
    Analysis) limit redistribution, and repos aggregating third-party model
    outputs carry mixed rights. Every row carries this; export and training
    gates check the specific right, not a blanket label."""

    can_store: bool = True         # may we keep a copy in our warehouse
    can_export: bool = False       # may the row appear in published artifacts
    can_train: bool = False        # may the row train models (judge/router)
    requires_attribution: bool = False
    gated: bool = False            # upstream requires auth / terms acceptance
    terms_url: str | None = None
```

#### 7.1 `BenchmarkTask` — the task registry (primary table)

One row per benchmark task instance. This is the spine: outcomes, artifacts,
and taxonomy labels all hang off it.

```python
class BenchmarkTask(BaseModel):
    # Identity
    benchmark: str                    # "swe-bench-verified", "livecodebench"
    benchmark_version: str            # "2026-06", "v5", dataset revision
    task_id: str                      # source-native id
    dataset_config: str | None = None # HF config / scenario family
    split: str | None = None          # "verified", "lite", "test", scenario name
    task_fingerprint: str | None = None  # sha256 of prompt+repo snapshot when
                                         # obtainable; links task across versions
                                         # and detects cross-benchmark near-dupes
    cluster_key: str | None = None    # statistical-independence cluster: repo
                                      # for repo benchmarks, contest for contest
                                      # benchmarks; drives clustered bootstrap
                                      # (§11.3) and leakage-safe splits
    # Taxonomy (§8)
    primary_domain: str
    task_operation: str
    language: str
    context_flags: list[str] = Field(default_factory=list)
    framework: str | None = None
    difficulty_source: str | None = None    # source-provided label if any
    difficulty_empirical: float | None = None  # 1 − mean pass rate, computed

    # Provenance & governance
    source_id: str                    # registry key of the ingesting source
    source_url: str
    source_revision: str | None = None  # git SHA / dataset revision fetched
    source_snapshot_hash: str
    retrieved_at: str                 # ISO 8601
    license: LicenseRights = LicenseRights()
    # Artifact pointers (never inlined; URIs into object storage or upstream)
    prompt_uri: str | None = None
    gold_patch_uri: str | None = None      # NEVER shown to any solver/judge
    gold_tests_uri: str | None = None      # NEVER shown to any solver/judge
```

Key: `(benchmark, benchmark_version, dataset_config, split, task_id)`.
`(benchmark, version, task_id)` alone is not unique in practice — the same id
recurs across splits (SWE-bench full/verified/lite) and scenario configs.

#### 7.2 `TaskOutcome` — the evidence spine

One row per (task, system, attempt-policy) observation. "System" means
model-under-scaffold; the identity facets make the distinction explicit.

```python
class TaskOutcome(BaseModel):
    # Task key (must match a BenchmarkTask row)
    benchmark: str
    benchmark_version: str
    dataset_config: str | None = None
    split: str | None = None
    task_id: str

    # Observation identity — one task can have many observations per system:
    # multiple leaderboard submissions, repeated trials, pass@k samples.
    submission_id: str | None = None  # e.g. SWE-bench submission directory name
    run_id: str | None = None         # trial/run identifier where the source has one
    sample_index: int | None = None   # pass@k sample number, if applicable
    repetition_index: int | None = None  # repeated-trial counter (Terminal-Bench)

    # System identity (§10)
    model_key: str                    # display key as reported by source
    base_model_key: str | None = None # canonical engine, e.g. "gpt-5"
    provider: str | None = None
    provider_model_id: str | None = None
    reasoning_effort: str | None = None
    harness_or_agent: str | None = None   # "swe-agent", "codex-cli", "official"
    scaffold_confounded: bool = False     # True => tier A− at best

    # Comparability group — correlation math only within identical groups (§11.3)
    harness: str
    evaluator: str | None = None      # grader identity/version if known
    attempt_budget: int | None = None # pass@k's k, or agent max-turns
    prompting_mode: str | None = None

    # The observation
    passed_or_score: float = Field(ge=0.0, le=1.0)
    scoring: ScoringMode
    cost_usd: float | None = None
    latency_s: float | None = None
    # Artifacts
    output_uri: str | None = None     # raw completion / patch / trace
    log_uri: str | None = None

    # Governance
    tier: EvidenceTier
    layer: Layer = "public_prior"
    source_id: str
    source_url: str
    source_revision: str | None = None
    source_snapshot_hash: str
    retrieved_at: str
    license: LicenseRights = LicenseRights()
```

Repeated observations (multiple trials, samples, submissions) are stored as
separate rows, never pre-averaged; aggregation to a per-system pass estimate
happens in analytics, where repetition variance is measurable.

#### 7.3 `AggregateScore` — leaderboard rows (demoted, still useful)

For sources that only publish per-model aggregates (Aider polyglot, Open LLM
Leaderboard, Artificial Analysis). Used for shortlisting and for coverage of
models that have no per-task rows — never for complementarity.

```python
class AggregateScore(BaseModel):
    model_key: str
    base_model_key: str | None = None
    provider: str | None = None
    benchmark: str
    benchmark_version: str
    area: str                         # taxonomy primary_domain or finer
    subarea: str | None = None
    score_raw: float
    score_direction: ScoreDirection = "higher_is_better"
    n_tasks: int | None = None
    scoring: ScoringMode
    harness_or_agent: str | None = None
    scaffold_confounded: bool = False
    date_observed: str
    tier: EvidenceTier               # "B" if n_tasks known + harness known, else "E"
    source_id: str
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str
    license: LicenseRights = LicenseRights()
```

#### 7.4 `PairwisePreference` — arena votes (tier C)

```python
class PairwisePreference(BaseModel):
    preference_id: str
    prompt_uri: str
    model_a: str
    model_b: str
    winner: Literal["a", "b", "tie", "both_bad"]
    judge_kind: Literal["human", "model"]
    domain_hint: str | None = None
    source_id: str
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str
    license: LicenseRights = LicenseRights()
```

Used exclusively to train/evaluate the judge (§15.4). Never enters
capability or complementarity math.

#### 7.5 Derived (never stored as ground truth)

- `AreaCell` — per (model, area): shrunk pass estimate + interval + tier
  floor + n. Recomputed from `TaskOutcome`/`AggregateScore`; a build
  artifact, not a table.
- `PanelCard` — §14.
- `DataQualityReport` — §13.

### 8. Taxonomy

A deliberately small, multi-axis label set. Public per-task data can populate
these axes reliably; finer axes (quality dimensions like maintainability or
security posture) are deferred until our own calibrated runs can measure
them.

```python
# src/capability_index/taxonomy.py
PRIMARY_DOMAINS = (
    "repo_bugfix",        # navigate + patch a real repository against an issue
    "algorithmic",        # self-contained function/contest problems
    "frontend_ui",        # UI generation, visual fidelity, browser behavior
    "backend_api_db",     # endpoints, auth, migrations, library/API usage
    "data_sql",           # pandas/SQL/ETL/analytics
    "devops_terminal",    # shell, docker, CI, environment debugging
    "refactor_migration", # behavior-preserving multi-file edits
    "security",           # secure implementation + exploit resistance
)
TASK_OPERATIONS = (
    "greenfield", "feature_add", "bugfix_debug",
    "refactor", "test_generation", "optimization",
)
LANGUAGES = (
    "python", "typescript_js", "sql", "shell", "go",
    "rust", "java", "cpp", "polyglot", "other",
)
CONTEXT_FLAGS = (
    "single_file", "multi_file_repo", "long_context",
    "tool_required", "browser_or_visual",
)
```

Rules:

1. **Benchmark source is never a domain.** A SWE-bench task is
   `repo_bugfix + python + multi_file_repo + bugfix_debug`, not "SWE-bench".
   Every source ships a mapping function from its native metadata to these
   axes (see per-source specs, §9.2). Where the source provides file paths or
   categories, refine: issue touching `auth/` files gains `security`; CI
   config files gain `devops_terminal`.
2. **Every source declares which labels it can emit** in its `SourceSpec`
   (§9.1). A row labeled outside its source's declaration is a data-quality
   error — this catches mapping bugs mechanically.
3. **Label lifecycle — the acid test.** A label earns its place only if it
   changes a decision. After the warehouse is populated, run this retention
   test per label, on public per-task data (where n is thousands, so the test
   has power):

   > A label survives if, for at least one model pair with ≥ 100 common
   > tasks on each side of the label split, the *sign* of the pass-rate
   > difference flips across the split, or the top-K panel selected within
   > the label differs from the globally selected panel with ≥ 80% bootstrap
   > stability.

   Labels that never change a ranking or a panel are merged away. Run the
   test at each index refresh; the taxonomy is versioned data, not code
   dogma.

   **Scope limit:** the retention test applies only to *data-supported
   splits* (sub-labels, context flags, language splits). The eight
   `PRIMARY_DOMAINS` are the **product taxonomy** — they exist because the
   product routes on them, and they are never deleted for lack of public
   coverage. A domain with thin public data (frontend, security) is marked
   `coverage: insufficient` and prioritized for calibration tasks; deleting
   it would just blind the index exactly where the product needs sight.
4. **Clustering refines, never defines.** It is tempting to embed prompts
   and cluster them into a taxonomy. Don't: that clusters by benchmark
   source and prompt style, not by routing-relevant capability. Use
   clustering only *after* labeled results exist, to propose splits (e.g.
   `frontend_ui` → component-logic vs. css-layout) where model rankings
   demonstrably differ inside a cell — then apply rule 3 to the proposal.

### 9. Source ingestion (Layer 1)

#### 9.1 The registry: connectors, not URLs

A naive `SourceSpec(url, parser)` with one `urlopen()` per source is the
wrong abstraction: almost none of the valuable sources is a single fetchable
URL. SWE-bench experiments is a git tree with per-submission directories
plus S3-hosted logs; BigCodeBench outcomes live in GitHub release assets
(zips); LiveBench via the HF datasets server is paginated at 100 rows/page;
LLMRouterBench ships archives; WebDev Arena is a gated HF dataset. The
registry therefore separates **acquisition** (a connector that materializes
a local snapshot directory of resources) from **parsing** (a pure function
over that directory).

```python
# src/capability_index/registry.py
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel

from capability_index.models import (
    AggregateScore, BenchmarkTask, LicenseRights, PairwisePreference, TaskOutcome,
)


class Resource(BaseModel):
    """One materialized file inside a source snapshot."""
    relpath: str                # path within the snapshot dir
    origin: str                 # URL / git path / s3 key / hf dataset+page
    sha256: str
    bytes: int


class SnapshotManifest(BaseModel):
    source_id: str
    source_revision: str | None = None   # git SHA / dataset revision
    retrieved_at: str
    resources: list[Resource]
    snapshot_hash: str          # sha256 over sorted resource hashes
    partial: bool = False       # some resources unavailable (e.g. S3 logs)
    errors: list[str] = []


# A connector materializes upstream data into a local snapshot directory and
# returns its manifest. Connector kinds to implement once, shared by sources:
#   http_file      — single file over HTTPS
#   github_tree    — git clone/sparse-checkout of paths at a pinned revision
#   github_release — release assets (zips), unpacked
#   hf_dataset     — HF hub download or datasets-server pagination (100/page),
#                    recording config, split, and page offsets per resource
#   s3_prefix      — optional, authenticated (SWE-bench logs); failure => partial
Connector = Callable[[Path], SnapshotManifest]


class ParseResult(BaseModel):
    tasks: list[BenchmarkTask] = []
    outcomes: list[TaskOutcome] = []
    aggregates: list[AggregateScore] = []
    preferences: list[PairwisePreference] = []


Parser = Callable[[Path, SnapshotManifest], ParseResult]
# (snapshot_dir, manifest) -> rows; pure, no network


class SourceSpec(BaseModel):
    source: str                       # registry key, e.g. "swebench_experiments"
    connector: Connector
    parser: Parser
    emits_tiers: tuple[str, ...]      # e.g. ("A-",) — validated against rows
    emits_domains: tuple[str, ...]    # taxonomy domains this source may label
    license: LicenseRights            # default rights stamped on emitted rows
    expected_row_range: tuple[int, int]  # volume smoke check (§18)
    description: str

    model_config = {"arbitrary_types_allowed": True}
```

`register_source` / `get_source_specs` are a plain dict registry as before.
The fetch pipeline is: connector materializes snapshot → manifest hashed and
stored → parser runs over the directory. Parsers stay pure and
golden-testable; connectors are the only networked code and are shared
infrastructure (five connector kinds cover all nine sources).

Fetch policy: **tolerant by default** — a failing source or resource records
`partial=True` / an error entry and the run continues; `--strict` turns any
failure into a non-zero exit for CI. CI never touches the network: parser
tests run against committed recorded snapshots (§18); a separate scheduled
job exercises live connectors and alerts on drift or volume anomalies
(row counts outside `expected_row_range`).

#### 9.2 Per-source specifications

Ordered by information value. "Volume" = order-of-magnitude `TaskOutcome`
rows obtainable.

**S1. LiveCodeBench per-question results — tier A, volume 10⁴, ingestion
path must be proven first.**
LiveCodeBench (github.com/LiveCodeBench/LiveCodeBench) evaluates four
scenarios (generation, self-repair, execution, test-output prediction) under
one official harness, with per-question, per-model results *produced* by its
eval pipeline (`{question_id, model, difficulty, pass@1}`-shaped records)
and surfaced through its leaderboard app and model-submission flow.
**Caution (verified in review): there is no guaranteed single public
"all-models per-question results" file.** The connector work here is to
identify the concrete artifact — the leaderboard app's data files, the
submissions repository, or locally re-scored `{eval_all_file}` outputs from
published generations — pin its revision, and only then claim tier A. Until
a concrete artifact URL + schema is proven, treat S1 as *candidate* tier A
and do not count it toward checkpoint C1 (§19) — use S5's LiveCodeBench
subset instead, which is downloadable in a known shape.
Parsing, once proven: one `TaskOutcome` per (question, model, scenario) with
`harness="livecodebench-official"`, `dataset_config=scenario`,
`scoring="deterministic_tests"`, `tier="A"`; one `BenchmarkTask` per question
(`primary_domain="algorithmic"`, operation by scenario: generation→
`greenfield`, repair→`bugfix_debug`, testgen→`test_generation`;
`language="python"`; `context_flags=["single_file"]`;
`cluster_key=contest_id`). **Contamination control:** record `contest_date`
per question; when computing any model's cells, only questions dated after
the model's release (identity table, §10) count as uncontaminated. Also emit
per-model `AggregateScore` rollups (tier B) for display continuity.

**S2. SWE-bench experiments — tier A−, volume 10⁴–10⁵.**
The repository github.com/swe-bench/experiments holds leaderboard
submissions as per-split directories (`evaluation/{lite,verified,test}/
<submission>/`) containing `metadata.yaml`, prediction files
(`all_preds.jsonl`), and `results/` with per-instance resolved/unresolved
ids. **Connector reality check (verified in review):** results and metadata
are in the git tree (use the `github_tree` connector at a pinned SHA), but
execution logs and trajectories are hosted on public S3 and require an AWS
account for bulk download — implement the S3 fetch as an optional,
authenticated connector stage; when absent, mark the manifest `partial` and
leave `log_uri` pointing upstream rather than blocking ingestion.
Parser: one `TaskOutcome` per (instance, submission) with
`submission_id` = submission directory name, `model_key` from metadata,
`harness_or_agent` = scaffold from metadata, `scaffold_confounded=True`
(tier A−), `split` from the directory, `harness="swebench-official-eval"`,
`scoring="deterministic_tests"`. `BenchmarkTask` rows come from the
SWE-bench dataset itself (`primary_domain="repo_bugfix"`, `language` from
repo, `context_flags=["multi_file_repo","tool_required"]`,
`cluster_key=repo` — mandatory here, since instances cluster heavily by
repository; refined labels from touched-file paths per §8 rule 1). This is
the largest public complementarity dataset for repo-level coding; its A−
tier means correlations describe *systems* (model+scaffold) — flag it on
every derived number. License note: submission artifacts aggregate
third-party model outputs; default rights `can_store=True, can_export=False`
until reviewed per submission.

**S3. LiveBench per-question rows — tier A, volume 10⁴–10⁵ (paginated).**
LiveBench (livebench.ai) exposes per-question model judgments as HF datasets
(`livebench/model_judgment`, ~60k+ rows). **Connector reality check:** the
datasets-server `/rows` endpoint paginates at 100 rows/page, so this is
hundreds of requests — prefer downloading the dataset's parquet exports via
the `hf_dataset` connector, recording config/split/revision (and page
offsets if the rows API is used) per resource. Parser: `TaskOutcome` per
row with `run_id` from the judgment record where present, `tier="A"`,
`scoring="llm_judge"` for judged categories (which widens intervals, §11.2);
map categories → taxonomy (`coding`→`algorithmic`,
`data_analysis`→`data_sql`; non-coding reasoning categories → shortlisting
aggregates only).

**S4. BigCodeBench pre-generated samples — tier A, volume 10⁴–10⁵.**
BigCodeBench (github.com/bigcode-project/bigcodebench) publishes 1,140
practical library-usage tasks, and pre-generated model samples plus
evaluated result files as **GitHub release assets** (e.g.
`sanitized_samples_calibrated.zip`, per-model `*_eval_results.json` /
`*_pass_at_k.json`) — use the `github_release` connector. Only samples with
matching eval results become `TaskOutcome` rows (`tier="A"`,
`scoring="deterministic_tests"`, `sample_index` recorded); samples without
execution results are ingested as `ModelAnswerArtifact` pointers only, not
outcomes. `BenchmarkTask` rows labeled by the libraries each task imports
(pandas/numpy/sqlite → `data_sql`; requests/flask → `backend_api_db`; else
`algorithmic`), `language="python"`,
`context_flags=["single_file","tool_required"]` per task metadata.

**S5. LLMRouterBench — tier A/B; coding subset is the usable part.**
github.com/ynulihao/LLMRouterBench standardizes per-instance outcomes for
~33 models across 21+ datasets (400K+ instances overall — but the *coding*
subset is a fraction of that; size it from the actual per-dataset archives
under `results/bench/.../*.json` before planning around it). Records carry
`origin_query, prompt, prediction, ground_truth, score`, tokens, cost.
Connector: archive/HF download, not streaming. Ingest coding subsets
(HumanEval/MBPP → `algorithmic+single_file`; its LiveCodeBench and SWE-bench
subsets as in S1/S2), grouping strictly per source dataset — cross-dataset
rows never share a comparability group. Beyond ingestion, this is the
**offline testbed for the selection math** (§11.4 acceptance test): large
enough to compare greedy top-K panels against exhaustive-search optima.
Caveat: its model pool lags the frontier — fine for validating *method*,
not for selecting *deployable* panels (see §19 checkpoint C0).

**S6. Terminal-Bench trajectories — tier A−, volume 10⁴ with repeated
trials.**
HF dataset `yoonholee/terminalbench-trajectories` (~52k rows, ~220 MB; and
the tbench.ai leaderboard) provides per-task agent outcomes with step-level
traces, cost, duration, and **repeated trials per (task, agent)** — store
`run_id`/`repetition_index` per row and never pre-average; repeated trials
are the only public source of run-to-run variance estimates. Parser:
`TaskOutcome` per trial, `scaffold_confounded=True`, domain
`devops_terminal`; derive trajectory features (failed-command count,
repeated-command loops, timeout flags) into task difficulty metadata —
these become router features later.

**S7. Aggregate leaderboards — tier E/B.**
Aider polyglot leaderboard (HTML), Open LLM Leaderboard (JSON API), BenchLM
category scores (JSON), Artificial Analysis (API, needs
`ARTIFICIAL_ANALYSIS_API_KEY`). Parser: `AggregateScore` rows only. Tier B
when `n_tasks` and harness are known, else E. Purpose: shortlisting, and
coverage for frontier models that have no per-task public rows yet.

**S8. Task-metadata-only sources — tier D.**
DS-1000 (data-science tasks with library labels), Spider 2.0 (enterprise SQL
with dialect/schema metadata), Design2Code (screenshot-to-code with
visual-fidelity metadata). Parser: `BenchmarkTask` rows only. Purpose: they
extend the task registry into `data_sql` and `frontend_ui` cells so
calibration slices (§15.1) can cover those domains even though no public
outcomes exist there.

**S9. WebDev Arena preference pairs — tier C, gated.**
HF dataset `lmarena-ai/webdev-arena-preference-10k` (~150 MB, **gated**:
requires terms acceptance and prohibits transfer/hosting): pairwise human
votes on generated web apps. Parser: `PairwisePreference` rows with
`license = LicenseRights(can_store=True, can_export=False, can_train=<per
terms review>, gated=True)`. Purpose: judge training/eval for frontend
(§15.4) — only if the terms review clears `can_train`. Its content never
appears in committed snapshots, fixtures, or exported artifacts.

Parser engineering notes, applying to all sources:

- Each parser is a pure function `(snapshot_dir, manifest) -> ParseResult`;
  no network inside parsers. This makes recorded-snapshot testing trivial.
- Every parser gets a **golden-snapshot test** against a recorded real
  payload with exact-value assertions. Synthetic-fixture tests validate
  logic; golden tests catch upstream schema drift, which is the actual
  failure mode of scrapers. **Committed snapshot policy:** only small,
  license-cleared, redacted excerpts go in git (a few hundred rows, no
  gated/restricted content, no raw traces); full recorded snapshots live in
  object storage referenced by checksum.
- Every `SourceSpec` declares `expected_row_range`; the scheduled live-fetch
  job alerts when a source's parsed volume or model-ranking churn versus the
  previous snapshot falls outside bounds (semantic drift can pass a parser
  while corrupting numbers).
- HTML scraping (Aider) is the most brittle; prefer JSON/CSV/parquet
  endpoints everywhere they exist, and treat scraped sources as tier-E
  shortlisting input only, so drift can't corrupt anything decision-critical.
- **Ownership:** each source has a named owner, a maintenance budget, and a
  retirement rule — *a source that fails refresh for two consecutive
  scheduled runs is excluded from selection until fixed* ("not refreshed
  means not used"). Parser upkeep against upstream drift is a standing
  operating cost, not a one-time build cost; plan for it.

### 10. Model identity resolution

The warehouse will contain rows for `gpt-5`, `gpt-5 (high)`,
`openai/gpt-5-2026-05`, `GPT-5 + SWE-agent`, etc. Without canonicalization,
diversity math treats these as four independent models and panel selection
happily builds a "diverse" panel of one engine at three reasoning settings.

Implementation (`identity.py`):

```python
class ModelIdentity(BaseModel):
    base_model_key: str          # canonical engine: "gpt-5"
    provider: str                # "openai"
    release_date: str | None     # for contamination windowing (§9.2 S1)
    is_open_weight: bool | None = None
    aliases: list[str] = []      # known display keys that map here
```

- A committed, reviewed identity table (`fixtures/model_identities.jsonl`)
  seeds known models. A generic normalizer (lowercase, strip provider
  prefixes, extract effort suffixes `-high`/`(high)`/`-thinking` →
  `reasoning_effort`, date suffixes `-2026-05` → `provider_model_id`) is
  **not sufficient on its own**: naming conventions differ structurally per
  source (Terminal-Bench uses `agent/model@provider`, SWE-bench uses
  free-form submission names, LLMRouterBench uses abbreviations). Each
  source therefore ships a *source-specific identity extractor* alongside
  its parser, and every resolution carries a `confidence` score; low-
  confidence resolutions are treated as unresolved.
- Rows whose `model_key` cannot be resolved get `base_model_key=None` and
  land in a **review queue** emitted by the data quality report; unresolved
  models are excluded from panel selection (they may still appear in
  shortlists, flagged). The quality report tracks **unresolved-row share
  per source**; a source above 10% unresolved is not selection-eligible
  until its extractor improves — this metric is the honest measure of
  whether identity resolution is keeping up with naming churn.
- Selection (§11.4) enforces **at most one variant per `base_model_key`**
  per panel as a hard constraint.

### 11. Analytics: from rows to panels

This is the mathematical core. Four stages: normalization, uncertainty,
complementarity, selection.

#### 11.1 Normalization and cross-benchmark linking

Raw scores from different benchmarks are not on one scale. Two tools:

**Within-cohort standardization.** A *cohort* is all models sharing
`(benchmark, benchmark_version, area, harness, prompting_mode)`. Within a
cohort of ≥ 8 models, compute z-scores `z = (s − μ)/σ`; for smaller cohorts
use rank quantiles (`(rank − 0.5)/n`). Never use min–max: it pins endpoints
(someone is always exactly 1.0 and someone 0.0 regardless of gaps) and one
new frontier model rescales everyone.

**Anchor linking across benchmarks within one area.** To place two
benchmarks' cohorts on a common area scale, fit the additive model

```
s_{m,b} = μ_b + θ_m + ε
```

by **constrained** least squares over observed (model, benchmark) pairs —
`θ_m` is the model's area ability, `μ_b` the benchmark offset. Three
correctness requirements the implementation must satisfy:

1. **Gauge constraint.** The additive model is underidentified as written
   (adding a constant to every `θ` and subtracting it from every `μ` gives
   the same fit): impose `Σ θ_m = 0` explicitly. Alternating means without
   the constraint drifts; with it, re-center `θ` after each sweep.
2. **Connectivity.** Solvable only when the model–benchmark bipartite
   overlap graph is **connected** (some models appear on both benchmarks,
   transitively). If two benchmarks share no models, refuse to merge their
   scales and keep separate columns with an explicit warning.
3. **Missingness diagnostics.** Which models get benchmarked is not random
   (frontier models are benchmarked selectively), which biases `μ_b`. Emit,
   per link fit: overlap counts, per-benchmark residual spread, and the
   `θ` shift when each single benchmark is dropped (a jackknife). Links
   whose jackknife shift exceeds one interval half-width are flagged
   `unstable_link` and excluded from selection inputs.

If benchmarks in one area have visibly different score *spreads* (not just
offsets), the additive model is wrong; upgrade that area to a scale-and-
shift model `s = a_b + b_b·θ_m` (still least squares, two parameters per
benchmark) before merging — and require ≥ 3 shared models per benchmark for
identifiability.

```python
# normalize.py — anchor linking sketch (pure stdlib; ~50 lines with checks)
def fit_anchor_link(
    observations: list[tuple[str, str, float]],  # (model, benchmark, z_score)
) -> tuple[dict[str, float], dict[str, float]]:
    """Constrained least squares for theta_m (model ability, sum-to-zero)
    and mu_b (benchmark offset) via alternating means with re-centering.
    Raise if the overlap graph is disconnected."""
    _assert_connected(observations)
    theta: dict[str, float] = {}
    mu: dict[str, float] = {}
    for _ in range(200):
        mu = _means_by(observations, key="benchmark", residual_of=theta)
        new_theta = _means_by(observations, key="model", residual_of=mu)
        _recenter_to_zero_mean(new_theta)          # gauge constraint
        if _max_delta(theta, new_theta) < 1e-9:
            theta = new_theta
            break
        theta = new_theta
    return theta, mu
```

#### 11.2 Uncertainty: intervals and shrinkage, never point estimates

Every per-cell pass-rate estimate carries an interval; selection consumes
intervals, not points.

**Wilson interval** for a pass rate with `n` tasks (z = 1.96 for 95%):

```python
import math

def wilson_interval(passed: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = passed / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, center - half), min(1.0, center + half))
```

**Empirical-Bayes shrinkage — toward the right prior.** Sparse cells must
not produce extreme point estimates, but shrinking a sparse *new* model
toward the area mean systematically penalizes exactly the models with the
least public coverage (the newest ones). Shrink toward a **covariate prior**
instead: fit the beta-binomial within strata of (provider family ×
open/closed weight × release-year cohort) when the stratum has ≥ 5 cells,
falling back to the area mean otherwise; and never let shrinkage flip a
selection decision on its own — sparse cells stay *wide*, and decisions on
wide cells defer to the decision-stability gate below.

**Tier and scoring-mode effects are precision modifiers, not score
multipliers.** A tier-B row or an `llm_judge`-scored row doesn't get its
score scaled down (that silently corrupts the estimate); it gets its
*effective n* discounted, which widens the interval. The initial discounts
(`n_eff = n × 0.5` for llm_judge, `× 0.35` for mixed-harness tier B) are
**provisional priors, and known to conflate bias with variance** — a judged
or stale source can be systematically *shifted*, not just noisier. From the
first calibration round onward, replace them with measured per-source
reliability: regress `logit(p_public) = logit(p_calibrated) + b_source + ε`
over cells observed in both layers, and carry each source's estimated bias
`b_source` (as a correction) and residual variance (as the precision
discount) instead of the hand constants (§12.4).

**Decision-stability gate, not a fixed interval cutoff.** A fixed
"interval wider than 40 points → excluded" rule is disconnected from the
decision: a 39-point interval can still flip a panel choice where headroom
is 5 points. The operative gate is resampling-based: draw from each cell's
posterior, re-run selection (§11.4) per draw, and require
`P(selected panel unchanged) ≥ 0.8` before a card publishes a
recommendation; otherwise the card reports the instability explicitly and
the slice is queued for calibration. The 40-point rule survives only as a
cheap pre-filter to keep obviously hopeless cells out of the resampling.

**Contamination and staleness** likewise enter as precision, via mechanisms
rather than hand weights: (a) LiveCodeBench-style date-windowing excludes
pre-release questions per model outright; (b) an area is flagged `saturated`
when the top-quartile models sit within one interval half-width of each other
(a saturated area carries little routing signal and its weight in profiles is
annotated); (c) `date_observed` recency decays `n_eff` with a 12-month
half-life.

#### 11.3 Complementarity: the outcome matrix and its statistics

All complementarity math operates on a **comparability group**: the set of
`TaskOutcome` rows sharing identical
`(benchmark, benchmark_version, harness, evaluator, attempt_budget,
prompting_mode)` and pairwise-common task ids. Mixing groups is refused with
a raised error, not a warning — this single guard prevents the most tempting
methodological sin (correlating failures across different harnesses and
calling it decorrelation).

Within a group, build the outcome matrix `y[m][t]`. **Binarize only
deterministic pass/fail suites**; for partial-credit or judged sources keep
`y ∈ [0,1]` fractional — `oracle`/`headroom` generalize directly
(`max`/`mean` over fractional values), and dependence between two models is
computed on fractional losses `1 − y` (Pearson over losses) rather than a
thresholded φ, so scoring mode doesn't silently change the statistic's
meaning. Repeated trials for one (task, system) are averaged into a single
`y[m][t]` *at this stage* (having been stored raw), with the trial variance
retained as a per-cell noise floor.

```python
# outcomes.py — core complementarity statistics
def pass_rate(y: dict[str, dict[str, float]], m: str) -> float:
    row = y[m]
    return sum(row.values()) / len(row)

def oracle(y: dict[str, dict[str, float]], subset: list[str]) -> float:
    tasks = set.intersection(*(set(y[m]) for m in subset))
    return sum(max(y[m][t] for m in subset) for t in tasks) / len(tasks)

def headroom(y, subset) -> float:
    return oracle(y, subset) - max(pass_rate_on_common(y, subset, m) for m in subset)

def unique_win_rate(y, subset, m) -> float:
    tasks = set.intersection(*(set(y[k]) for k in subset))
    wins = sum(
        1 for t in tasks
        if y[m][t] >= 1.0 and all(y[k][t] < 1.0 for k in subset if k != m)
    )
    return wins / len(tasks)

def failure_phi(
    y, a: str, b: str,
    *,
    min_common: int = 150,
    min_marginal: int = 20,
) -> float | None:
    """Phi coefficient between failure indicators of two models.

    Refuses (returns None) unless there are >= min_common common tasks AND
    each marginal count (fails_a, passes_a, fails_b, passes_b) is
    >= min_marginal: phi is wildly unstable at extreme pass rates, where a
    handful of discordant tasks swings it across its whole range. 30 common
    tasks — an earlier draft's floor — is far too few for a number that
    gates panel composition."""
    common = sorted(set(y[a]) & set(y[b]))
    if len(common) < min_common:
        return None
    fa = [1 - int(y[a][t] >= 1.0) for t in common]
    fb = [1 - int(y[b][t] >= 1.0) for t in common]
    if min(sum(fa), len(fa) - sum(fa), sum(fb), len(fb) - sum(fb)) < min_marginal:
        return None
    n11 = sum(x and z for x, z in zip(fa, fb))
    n00 = sum((not x) and (not z) for x, z in zip(fa, fb))
    n10 = sum(x and (not z) for x, z in zip(fa, fb))
    n01 = sum((not x) and z for x, z in zip(fa, fb))
    denom = math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
    return ((n11 * n00) - (n10 * n01)) / denom if denom else None
```

**Independence and pooling rules.** Tasks are not i.i.d.: SWE-bench
instances cluster by repository, contest problems by contest. All bootstrap
resampling here is **clustered** — resample `cluster_key` groups (§7.1),
not individual tasks; intervals from task-level bootstrap on clustered data
are overconfident. And when a metric is computed across strata (e.g. mixing
difficulty slices or repos), compute it *within* strata and meta-analyze
(Fisher-z average for correlations), refusing a pooled headline number when
between-stratum heterogeneity is high — pooling with different difficulty
mixes per model is how Simpson's paradox manufactures fake complementarity.

Interpretation targets (used by cards and selection):

- `oracle(S)` — the panel ceiling: if a perfect judge always picked the best
  member's answer, this is the pass rate.
- `headroom(S)` — what fusion can possibly add over the best member. If
  headroom ≈ 0, the panel is *lopsided* and fusion is pointless there.
- `failure_phi` — pairwise error correlation. φ near 0 or negative between
  strong models is the fusion-friendly signal. Empirical guardrail: no panel
  pair should exceed φ ≈ 0.7 on the target task class.
- `unique_win_rate(m|S)` — the per-member justification: how often m alone
  saves the panel.

For A− (scaffold-confounded) groups these statistics are computed
identically but every derived number carries `system_level=True` — they
describe model+scaffold systems.

Report intervals on oracle/headroom via clustered bootstrap (1,000 resamples
over `cluster_key` groups).

#### 11.4 Panel selection: top-K from N

**The objective.** A judged panel does not collect the oracle: the judge
picks wrong sometimes. Model the realized value of panel `S` in domain `d`:

```
V(S, d) = best_pass(S, d) + capture(d) × headroom(S, d) − λ·cost(S) − μ·latency(S)
```

where `capture(d) ∈ [0,1]` is the fraction of *headroom* a judged ensemble
actually realizes in that domain. Defined precisely (and this matters —
`judged/oracle` is a common, wrong shortcut that conflates base pass rate
with judge skill and looks flatteringly high whenever headroom is small):

```
capture(d) = (p_fused(d) − p_best_single(d)) / (p_oracle(d) − p_best_single(d))
```

measured on the *same paired tasks* in Layer 2, with a clustered-bootstrap
CI, and clamped to [0,1] when headroom is within noise of zero (in which
case capture is reported as `undefined` and the panel is lopsided anyway).
Before Layer-2 data exists, use a conservative prior `capture = 0.7`; after
the first calibration round, use the measured value per domain (§15.3).

**The algorithm — with an honest note on guarantees.** `oracle(S)` alone is
a coverage function — monotone submodular in `S` — and *unconstrained*
cardinality-limited greedy on it carries the classical (1 − 1/e) guarantee.
The objective actually optimized, `V(S,d)`, adds the capture-scaled
headroom, subtracts costs, and runs under engine/provider constraints —
**the classical guarantee does not transfer to it.** The practical remedy
is that K is tiny: for K ≤ 4 over a shortlist of ≤ ~20 candidates,
**exhaustive search over the feasible subsets is cheap and exact** — use it
as the default. Greedy remains valuable as (a) the ranked-members view with
attributable marginal value for cards, and (b) the fallback when candidate
pools are unusually large; whenever both run, report the empirical
greedy-vs-exact gap.

```python
# select.py — sketch (exhaustive path elided; greedy shown for the
# ranked-members view)
class PanelMember(BaseModel):
    model_key: str
    base_model_key: str
    provider: str
    marginal_value: float          # V(S) − V(S \ {m}) at selection time
    unique_win_rate: float
    max_pairwise_phi: float | None
    capability_interval: tuple[float, float]
    evidence_tier: EvidenceTier    # weakest tier feeding this member's numbers
    selection_basis: Literal["task_outcomes", "aggregate_proxy"]
    reason: str


def select_panel(
    y: dict[str, dict[str, float]],         # outcome matrix for the domain group
    candidates: list[str],
    *,
    k: int = 3,
    capture: float = 0.7,
    cost_per_model: dict[str, float] | None = None,
    lambda_cost: float = 0.0,
    require_provider_diversity: bool = True,
    identities: dict[str, ModelIdentity],
) -> list[PanelMember]:
    selected: list[str] = []
    used_bases: set[str] = set()
    used_providers: set[str] = set()
    members: list[PanelMember] = []
    while len(selected) < k:
        best, best_gain = None, 0.0
        for m in candidates:
            if m in selected:
                continue
            base = identities[m].base_model_key
            if base in used_bases:                       # hard: one variant per engine
                continue
            if require_provider_diversity and identities[m].provider in used_providers:
                continue
            gain = _value(y, selected + [m], capture, cost_per_model, lambda_cost) \
                 - _value(y, selected, capture, cost_per_model, lambda_cost)
            if best is None or gain > best_gain:
                best, best_gain = m, gain
        if best is None:
            break                                        # relax diversity w/ warning, or stop
        selected.append(best)
        used_bases.add(identities[best].base_model_key)
        used_providers.add(identities[best].provider)
        members.append(_describe(y, selected, best, best_gain))
    return members
```

**The fallback ladder**, explicit and labeled, for candidates or domains
without tier-A/A− outcome coverage:

1. *Task outcomes available* → the greedy above
   (`selection_basis="task_outcomes"`).
2. *Aggregates only* → capability-vector diversity proxy: represent each
   model as its vector of normalized area scores; a candidate's diversity
   score is `1 − max cosine similarity` against already-selected members,
   computed **only over jointly observed areas** with ≥ 3 shared areas
   required (else the score is a neutral 0.5 plus a warning) — never impute
   missing areas as zero, which manufactures similarity out of shared
   coverage and diversity out of coverage holes. Members chosen this way are
   labeled `selection_basis="aggregate_proxy"` and the card must show it.
   This proxy is *weak by nature*: two models with identical capability
   profiles but independent errors — the best possible fusion pair — score
   worst on it. It exists only because it beats nothing.

**Constraints and knobs:** `k` (default 3), provider diversity (default on,
relaxed with a recorded warning when it would leave the panel short), cost
cap, one-variant-per-engine (never relaxed).

### 12. Index self-validation

The index is a prediction machine; its trustworthiness is an empirical
number, measured after every calibration round (§15) and published with the
cards. The **primary gate** is the one that matches the decision the index
actually makes:

1. **Calibrated selection regret** (primary) — on the calibrated bank,
   compare the panel the index selected against the best feasible panel in
   hindsight:
   `Δ(d) = V_cal(best_feasible_panel, d) − V_cal(index_selected_panel, d)`,
   with a clustered-bootstrap CI. Gate: the CI upper bound of `Δ(d)` must be
   below the value of one headroom point×capture (i.e. the index's choice is
   statistically indistinguishable from, or close to, hindsight-optimal)
   before index selections may auto-seed default panels in domain `d`
   without human review. This is the right gate because ranking correlation
   can be high while the *selected panel* is still wrong, and vice versa.
2. **Complementarity fidelity** — |predicted headroom(S) − measured
   headroom(S)| for the selected panel, and sign agreement between predicted
   and measured pairwise failure dependence.
3. **Diagnostics (reported, never gates)** — Spearman ρ between predicted
   and calibrated per-domain rankings (unstable and weakly meaningful over
   the 5–10 models actually ranked — treat as a trend indicator only), and
   Brier score of predicted P(pass) per model×domain.
4. **Prior→posterior movement** — per source, estimated bias `b_source` and
   residual variance from the §11.2 reliability regression. Sources that
   consistently mislead get corrected and down-weighted; this is how
   hand-set precision constants are replaced by measured ones over time.

### 13. Data quality, provenance, licensing

`quality.py` computes a `DataQualityReport` over any snapshot; the CLI
supports `--fail-on-quality-errors` for CI. Checks (each an error or warning
with row references):

- duplicate rows (same task key + system + attempt policy from one source);
- a source emitting a domain/tier outside its `SourceSpec` declaration;
- `TaskOutcome` rows claiming tier A while `scaffold_confounded=True`
  (must be A−) or with missing `harness`;
- unresolved model identities (review queue, §10);
- outcome rows referencing tasks absent from the registry;
- comparability groups with < 2 models (useless for complementarity — info);
- tier-A/A− rows missing `n`-relevant fields;
- unresolved-identity share per source above the 10% eligibility bound (§10);
- **license**: rows with `can_export=False` present in an export-bound
  artifact, or `can_train=False` rows in a judge/router training set. Export
  functions (`cards.py`, snapshot publishing) strip non-exportable rows and
  record what was stripped; internal selection may still use `can_store`
  rows.

Provenance invariants: every row carries
`source_id + source_url + source_revision + source_snapshot_hash +
retrieved_at`; every derived artifact records the input snapshot hashes and
the git SHA of the code that built it.

**Determinism, specified precisely** (byte-identical is not free): derived
artifacts are serialized with canonical JSON — sorted keys, explicit
separators, `repr`-stable float formatting via a fixed quantization (e.g.
round to 6 decimal places at serialization), lists sorted by a declared key
— and contain **no wall-clock timestamps**; the top-level `generated_at` is
*derived* (the max `retrieved_at` across input snapshots), so the same
inputs always produce the same bytes. The determinism test (§18) enforces
this by building twice and comparing digests.

### 14. Panel cards — the product artifact

A **panel card** is the versioned, reviewable answer to "which models should
form the panel for subdomain X, and why". One card per (primary_domain,
optionally language) slice with sufficient evidence. Cards are generated
JSON + rendered markdown, committed to a `cards/` directory by CI on refresh.

```yaml
panel_card:
  card_id: repo_bugfix.python.v3
  slice: {primary_domain: repo_bugfix, language: python}
  generated_at: 2026-07-04T00:00:00Z
  built_from:
    index_snapshots: [sha256:aaa..., sha256:bbb...]
    calibration_bank: bank-2026-07-01        # absent before first calibration
    code_sha: abc123
  panel:
    - model: {base_model_key: gpt-5, reasoning_effort: high, provider: openai}
      marginal_value: 0.11
      unique_win_rate: 0.14
      max_pairwise_phi: 0.38
      capability: {p: 0.61, interval: [0.55, 0.67], n_eff: 214}
      evidence_tier: A-
      selection_basis: task_outcomes
      reason: >
        Highest standalone pass rate in slice; low failure correlation with
        claude member (phi=0.38, system-level evidence from SWE-bench
        submissions); wins alone on 14% of tasks.
    - ...
  judge:
    model: ...
    capture_rate: {value: 0.74, source: calibrated}   # or {value: 0.70, source: prior}
  expected:
    best_single: 0.63
    oracle: 0.78
    panel_value: 0.71          # best_single + capture × headroom
    cost_per_task_usd: 0.19
  evidence_floor: A-           # weakest tier behind ANY number above
  warnings:
    - "phi computed on scaffold-confounded rows; system-level"
    - "frontend coverage in this slice is aggregate-proxy only"
  refresh_trigger: "new shortlisted model OR snapshots older than 60 days"
```

Hard rules enforced by `cards.py`:

- **Cards are recommendations only when the evidence supports one.** A card
  is emitted in one of two modes: `recommendation` (requires evidence floor
  ≥ A− for all complementarity numbers, the §11.2 decision-stability gate
  passed, and — for panels of *currently deployable* models — either
  current-model per-task rows or a completed calibration round) or
  `evidence_report` (coverage summary, shortlist with
  `selection_basis: aggregate_proxy`, no complementarity numbers, and an
  explicit `requires_calibration` marker). Domains where public outcomes
  don't exist (frontend, full-stack) ship as evidence reports — an honest
  "we can't know this from public data yet", not a decorated guess.
- Every number carries its tier; the card's `evidence_floor` is the minimum.
- Cards also emit a machine-readable panel preset consumable by the Layer-2
  bench runner. **Integration constraint (verified against the code):**
  `fusionkit_evals.benchmark_panel.BenchmarkPanel` validates that `judge_id`
  and `synthesizer_id` are ids of *panel members* — a card recommending an
  out-of-panel judge will fail preset validation. Either cards constrain
  the judge to a panel member, or `BenchmarkPanel` gains an external-judge
  variant *before* cards promise one; decide at implementation time, but do
  not ship cards that emit invalid presets.

### 15. Layer 2: calibration

Layer 1 predicts; Layer 2 verifies, on our own harness, with our own money,
on a slice chosen to maximize information per dollar.

#### 15.1 Choosing the calibration slice: two slices, not one

A slice selected for high model disagreement is **not a random sample** —
pass rates, oracle, headroom, and capture measured on it are biased (upward
for headroom, unpredictably for pass rates), and no weight-stability check
fixes that; it is a selection effect, not a sensitivity problem. The design
therefore uses two slices with different jobs, reported separately and never
pooled:

**(a) Estimation slice — stratified random.** Sampled randomly within
taxonomy-cell strata (and cluster-aware: sample repos, then tasks within
repos), with at least half of it drawn to be *production-representative*
(matching expected traffic mix across domains) rather than
benchmark-convenient. This slice is the only legitimate source of unbiased
`p̂`, oracle, headroom, and capture estimates. If inclusion probabilities
are unequal across strata, estimate with inverse-inclusion weights:
`p̂_m = Σ_t w_t·y_{m,t} / Σ_t w_t`, `w_t = 1/π_t`.

**(b) Diagnostic slice — actively selected.** Chosen to maximize
information about *model differences*: for each candidate task, from the
mined public matrix restricted to the shortlist, compute

```
disagreement(t)  = variance of pass across shortlisted models on t
entropy(t)       = binary entropy of mean pass on t
undercoverage(t) = 1 if t's taxonomy cell is below its target n
complementarity(t) = 1 if t is a unique-win task for some shortlist pair

info(t) = 0.30·disagreement + 0.20·entropy + 0.20·undercoverage
        + 0.15·complementarity + 0.10·traffic_relevance
        − 0.10·runtime_estimate − 0.15·flakiness_risk − 0.20·license_risk
```

and take the top scorers (excluding flaky graders). This slice powers
pairwise comparisons, φ estimates, and judge evaluation — quantities where
enrichment for discordance is *efficient* rather than biasing (McNemar uses
only discordant pairs anyway). It must never feed headline pass rates.

Budget split: roughly 50/50 across 150–440 total tasks, covering the 3–4
domains with the densest public coverage plus (from the estimation slice's
traffic-representative half) the domains the product needs regardless of
public coverage. Per-cell floors: ≥ 30/cell for directional signal,
≥ 100/cell for routing-grade confidence.

**Weight-stability check** (diagnostic slice only): re-run selection under
±50% perturbation of the `info` weights; require ≥ 80% overlap. If selection
is weight-fragile, the slice is arbitrary — widen it or fix the inputs.

#### 15.2 Running the slice — apples-to-apples invariants

Use the existing `fusionkit-evals` harness (`fusion_bench` / `public_bench`);
do not build a new runner. The non-negotiable controls, all recorded in a run
manifest emitted with the report:

- identical prompt template, agent scaffold, tool set, tool budgets, max
  turns, context cap, temperature policy for every model;
- pinned provider backend per model — no silent gateway fallback or model
  substitution; log resolved backend + request ids + pricing snapshot;
- identical sandbox image (digest-pinned), grader version, timeouts;
- every model runs every task (paired design), interleaved in time, not
  batched per model across days;
- 5–10% of tasks run twice to estimate run-to-run variance; tasks whose
  repeat disagrees get quarantined;
- judge protocol: candidates anonymized and order-randomized; judge sees
  public logs (build/test output, diff stats) but never hidden tests or gold
  patches; judge decisions and correctness logged per task.

Cost model for planning: `|slice| × (K generators + 1 judge)` runs; 300
tasks × 4 = 1,200 billed runs per calibration round.

#### 15.3 Feeding results back

The bench runner freezes results into a `CandidateBank`. Its actual shape
(verified against `fusionkit_evals/candidate_bank.py`): `CandidateBank` has
`signature`, `panel_models`, and `tasks: list[BankTask]`; each `BankTask`
has `task_id`, `prompt`, `tests`, `difficulty`, and
`candidates: list[BankCandidate]` where `BankCandidate` is
`{model_id, content, passed}`. The adapter iterates candidates:

```python
# calibration.py
from datetime import datetime, timezone

from fusionkit_evals.candidate_bank import CandidateBank

from capability_index.models import LicenseRights, TaskOutcome as IndexTaskOutcome
# Import alias is load-bearing: fusionkit_evals defines an unrelated
# TaskOutcome Literal ("scored" / "model_failed" / ...) in public_bench /
# bench_runtime. Never let the two collide in one namespace.


def bank_to_outcomes(bank: CandidateBank, *, harness: str) -> list[IndexTaskOutcome]:
    retrieved_at = datetime.now(timezone.utc).isoformat()
    rows: list[IndexTaskOutcome] = []
    for task in bank.tasks:
        for candidate in task.candidates:
            rows.append(IndexTaskOutcome(
                benchmark="calibration",
                benchmark_version=bank.signature,
                task_id=task.task_id,
                model_key=candidate.model_id,
                harness=harness,
                scoring="deterministic_tests",
                passed_or_score=1.0 if candidate.passed else 0.0,
                tier="CAL",
                layer="calibrated",
                scaffold_confounded=False,
                source_id="candidate_bank",
                source_url="internal://candidate-bank",
                source_snapshot_hash=bank.signature,
                retrieved_at=retrieved_at,
                license=LicenseRights(can_store=True, can_export=True, can_train=True),
            ))
    return rows
```

These tier-CAL rows flow into the same warehouse and the same analytics.
`capture(d)` gets measured per §11.4's corrected definition —
`(p_fused − p_best_single) / (p_oracle − p_best_single)` on paired tasks
from the judge decision log, **estimation slice only** (measuring capture on
the disagreement-enriched diagnostic slice overstates it); §12 fidelity
metrics get computed; cards get regenerated with calibrated numbers where
available.

Additionally, run the existing diagnostics on the bank —
`fusion_hillclimb.diagnose_bank()` (oracle ceiling, best single, mean failure
correlation, lopsidedness) and
`fusion_compound.compare_compound_vs_individual()` (fused vs. best single
with paired McNemar) — these are the numbers that back any public claim.
One hardening note found in review: `diagnose_bank`'s failure-correlation
helper pairs failure lists positionally rather than by explicit task-id
intersection; when wiring the bridge, compute the index's own φ from the
task-keyed matrix (which is explicit about intersections and clustering)
and treat the bank diagnostic as a cross-check.

#### 15.4 Judge development (uses tier-C data)

The judge is a benchmarked component, not an assumption:

- Training/eval pairs from public artifacts: SWE-bench submission pairs
  where patch A passed and patch B failed on the same instance (the judge
  should pick A); BigCodeBench sample pairs likewise; WebDev-Arena
  preferences for frontend taste.
- Measured on calibration runs, conditioned:
  `accuracy_when_exactly_one_correct` (the number that matters),
  `when_both_correct`, `false_confidence_when_both_wrong`; plus position
  bias (choice vs. presentation order) and verbosity/patch-size bias
  (choice vs. length deltas).
- Domain-level `capture(d)` is the judge's summary statistic and feeds
  selection directly (§11.4).

### 16. Router (staged, after cards exist)

The router decides per incoming task: single model (which?), full panel, or
cheap-first-escalate.

**Stage 0 — the unacknowledged prerequisite: a runtime task labeler.**
Cards are keyed by taxonomy labels, but an incoming production task arrives
as a raw prompt (plus repo context) with no labels. Before any router can
consume cards, something must map the live request → (primary_domain,
language, context flags, risk) *at request time, cheaply*. Spec: a
lightweight classifier (few-shot small-model call or embedding classifier)
with a per-label confidence score; below-threshold confidence routes to the
safe default (full panel) and is logged. The labeler is evaluated like any
component — labeled holdout of production-like prompts, per-label
precision/recall — and its error rate is part of router regret accounting
(a perfect per-domain policy under a wrong domain label is still a wrong
route). Build and measure this before claiming the rule router is
deployable.

Then build the router in two stages and resist skipping stage 1:

**Stage 1 — rule-based, from cards.** Per domain slice:

```
if best_single_dominates(card):        # headroom × capture < judge overhead
    route = card.panel[0]              # specialist single
elif cheap_model_pass(card) >= 0.8 and task.risk == low:
    route = cheap_first_then_escalate
else:
    route = full_panel_plus_judge
```

Transparent, debuggable, needs no training data, and establishes the
baseline any learned router must beat.

**Stage 2 — learned, only after calibration data accumulates.** Features:
taxonomy labels, prompt embedding, repo-size/file-count metadata, tool
requirements. Targets: P(pass) per candidate route + expected cost/latency;
decide by `argmax expected_quality − λ·cost − μ·latency`. **Leakage rules**,
absolute: the router never sees benchmark source name, benchmark task ids,
or public outcome labels for the same task as features — else it learns
"if DS-1000 then model B" and dies in production. Validate on three splits:
in-domain holdout, cross-source holdout (train public → test private),
future holdout (post-cutoff tasks). Track
`router_regret = oracle_best_route − router_route`, decomposed into
`unnecessary_ensemble_rate` and `missed_ensemble_opportunity_rate`.

### 17. CLI

```
uv run --package capability-index capability-index \
    fetch      [--source S ...] [--strict] [--timeout-s N] \
               [--write-tasks PATH] [--write-outcomes PATH] [--write-aggregates PATH]
    quality    --snapshot PATH [--fail-on-quality-errors]
    matrix     --snapshot PATH [--domain D] [--format json|markdown] [-o PATH]
    select     --snapshot PATH --domain D [-k 3] [--capture 0.7] [--cost-cap X]
    card       --snapshot PATH --slice repo_bugfix.python [-o cards/]
    calibrate  plan --snapshot PATH --shortlist m1,m2,... [--budget-tasks 300]
    calibrate  ingest --bank PATH        # CandidateBank → tier-CAL rows
    validate   --snapshot PATH --bank PATH   # §12 fidelity report
```

Each subcommand is a thin wrapper over library functions; everything is
scriptable without the CLI.

### 18. Testing strategy

- **Schema/property tests**: round-trip every model through JSONL; reject
  malformed tiers/layers; fuzz parsers with truncated/permuted payloads
  (they must fail loudly, never emit partial garbage); a schema-migration
  test (old-snapshot rows load under the current schema or fail with a
  named migration error).
- **Recorded-snapshot parser tests** (the critical ones): license-cleared
  excerpt snapshots under `snapshots/`, exact-value assertions. When an
  upstream schema drifts, this fails loudly instead of numbers drifting
  quietly.
- **Volume smoke tests**: each source's parsed row count within its
  `expected_row_range` (catches silent partial ingestion).
- **Identity acceptance tests**: known-alias table resolves; per-source
  unresolved share below the eligibility bound on the recorded snapshots.
- **Analytics unit tests with hand-computable cases**: e.g. the 3-model,
  3-task matrix where gemini uniquely wins t3 → `oracle = 1.0`,
  `unique_win(gemini) = 1/3`; verify selection picks the complementary pair
  over two look-alike high scorers; verify φ floors refuse under-sampled
  pairs.
- **Selection acceptance test** (the packaged C2, pre-registered): on
  held-out *clusters* of the validation dataset, complementarity-selected
  panels beat top-K-by-average with a clustered-bootstrap lower bound > 0;
  greedy-vs-exhaustive gap reported for K ≤ 3.
- **Determinism test**: same snapshots in → byte-identical artifacts out
  (canonical JSON per §13), built twice and digest-compared.
- **Quality-gate test**: seeded bad rows (duplicate, undeclared domain,
  non-exportable license in an export, unresolved identity above bound)
  each trigger their check.

### 19. Implementation chronology and build order

The milestones in §20 define *acceptance gates*; this section defines the
*order of construction* — what to code first, what depends on what, what can
proceed in parallel, and where the go/no-go checkpoints sit. Five principles
govern the ordering:

1. **Prove it in a notebook before building it as a package.** The
   go/no-go questions (does public data cover deployable models? does a
   decorrelation signal exist? does it transfer to our harness?) can be
   answered with throwaway analysis and one small billed run. Warehouse,
   cards, and router are built only after those answers are in.
2. **Front-load the two riskiest assumptions.** The project rests on two
   empirical bets: (a) public per-task data contains an exploitable
   decorrelation signal for *models we would actually deploy*, and (b) that
   signal **transfers** to our unified production harness — public
   complementarity could be an artifact of scaffold diversity, prompt
   styles, or contamination that evaporates under one harness. Bet (a) is
   testable free (checkpoints C0–C2); bet (b) needs a small amount of real
   money *early* (checkpoint C3), not after the whole Layer-1 build.
3. **Walking skeleton before breadth.** Once building, get the thinnest
   end-to-end slice working before adding sources.
4. **Freeze schemas early.** Everything imports `models.py`; churn there
   multiplies across every parser and analytics module. The bootstrap phase
   ends with a schema review and a deliberate freeze; later schema changes
   are treated as migrations.
5. **Separate breadth work from depth work.** Source parsers are
   embarrassingly parallel breadth work (each an independent pure function
   with its own golden test). Analytics is sequential depth work. After
   bootstrap they proceed on independent tracks and can be split across
   engineers.

#### Dependency graph

```
Phase-0 validation study (notebook + C3 pilot) ──▶ go / descope decision
        │
        ▼
models.py ──────────────┬──────────────┬─────────────────┬──────────────┐
                        ▼              ▼                 ▼              ▼
             registry.py (connectors)  outcomes.py   quality.py   taxonomy.py
                        │              │                 │              │
        ┌───────────────┤              ▼                 │              │
        ▼               ▼         select.py              │              │
  sources/swebench  sources/llmrouterbench               │              │
  (needs identity.py + source-specific extractors)       │              │
        │               │              │                 │              │
        │               ▼              │                 │              │
        │       sources/{livebench, bigcodebench,        │              │
        │                terminal_bench, livecodebench*} │              │
        │               │              │   (*once artifact proven)      │
        └───────┬───────┘              │                 │              │
                ▼                      ▼                 ▼              ▼
          normalize.py ─────────▶ cards.py ◀─────────────┴──────────────┘
        (+ aggregates,                 │
           preferences)                ▼
                              calibration.py ──▶ validate.py ──▶ labeler
                              (fusionkit-evals bridge)          + router
```

Critical path: **Phase 0 (validation study, incl. the C3 transfer pilot) →
1 (bootstrap) → 2 (skeleton) → identity → source breadth → cards → full
calibration → validation → labeler + router.** Everything else hangs off
the path and parallelizes.

#### Phase 0 — the validation study (notebook-scale, before any package)

No package code. A throwaway analysis directory plus one small billed run,
answering four checkpoints in order. All later phases are conditional on
their outcomes.

**Checkpoint C0 — deployable-model coverage.** List the models the product
would actually deploy *today* (from the model catalog / gateway registry).
For each, count available public per-task rows per source. This is a
half-day of scripting and it determines the project's shape: if the
deployable frontier has essentially no tier-A/A− coverage (plausible —
public per-instance data lags the frontier by months), then complementarity
mining describes obsolete models, and the build collapses honestly to
*shortlisting (aggregates) + calibration-first* — a much smaller system.
Record the coverage table; it is the first artifact.

**Checkpoint C1 — does a decorrelation signal exist at all?** Hand-ingest
one same-harness per-instance dataset (SWE-bench experiments results via a
git checkout, or LLMRouterBench's coding archives — whichever is fastest;
do *not* block on the LiveCodeBench artifact hunt, §9.2 S1). Compute
pairwise failure dependence and headroom for panels of the strongest
systems. Pass: headroom over best single ≥ 5 points for some 2–3 system
panel with the φ floors of §11.3 met. Fail: strong systems' failures all
correlate ≥ ~0.8 — stop and reassess.

**Checkpoint C2 — does complementarity selection beat average-score
selection?** On the same data, pre-registered before looking: model
universe, K, train/held-out split (clustered), objective, and test. Pass
only if the complementarity-selected panel's held-out oracle gain over the
top-K-by-average panel has a clustered-bootstrap lower bound > 0. Also
record the greedy-vs-exhaustive gap (expect exhaustive to be the shipping
algorithm; §11.4).

**Checkpoint C3 — does it transfer to our harness?** The earliest billed
spend, deliberately small: 50–150 tasks through the *existing*
`fusionkit-evals` harness with the deployable shortlist (this needs only
the bench runner that already exists plus a hand-rolled task list — no new
package). Compare: does the public-data-selected panel beat (i) the
top-average panel and (ii) a provider-diverse default, on measured headroom
and fused uplift? Do public φ signs agree with calibrated φ signs? This is
the transfer gate — the strongest known risk (§21) — and it runs *before*
the warehouse is built, not after.

Outcomes: all four pass → build Phases 1–6 as specified. C0 fails →
descope to shortlisting + calibration tooling (skip §11.3–11.4 mining paths
and most parsers). C1/C2 fail → same descope. C3 fails → public priors are
demoted to task-selection only (tier policy tightened: A/A− rows may inform
*which tasks to run*, never *which panels to pick*); the warehouse may
still be worth building at reduced scope for calibration design.

#### Phase 1 — package bootstrap

Build: `pyproject.toml` + workspace registration; `models.py` complete (§7
schemas — resist "add fields later"); JSONL read/write helpers; empty CLI;
CI wiring (`ruff`, `pyright`, `pytest`). The Phase-0 notebook code is the
reference implementation to port, now with tests.
Exit: fixture rows round-trip through every schema; CI green; schema review
held and schemas declared frozen.

#### Phase 2 — walking skeleton

Build, in order: `registry.py` (connectors + SourceSpec); the source that
won C1 (`sources/swebench_experiments.py` or `sources/llmrouterbench.py`)
with its recorded-snapshot test; `outcomes.py` (matrix building, `oracle`,
`headroom`, `failure_phi` with floors, clustered bootstrap);
`select.py` (exhaustive small-K + greedy ranked view); `matrix` and
`select` CLI commands. Exit: the C1/C2 numbers reproduce from the package
pipeline, byte-deterministically.

#### Phase 3 — evidence breadth, identity, governance (three parallel tracks)

- **Track A — sources** (split per source): `identity.py` +
  source-specific extractors first (SWE-bench ingestion is useless without
  them), then the remaining per-task sources in coverage order for
  *deployable* models (per the C0 table): `sources/livebench.py`,
  `sources/bigcodebench.py`, `sources/terminal_bench.py`, and
  `sources/livecodebench.py` once its artifact is proven. Each lands with
  its recorded-snapshot test; each is independently shippable.
- **Track B — governance**: `quality.py` full check suite (incl. license
  rights and unresolved-identity share); `taxonomy.py` mappings + the
  label-lifecycle retention test runner.
- **Track C — analytics depth**: `normalize.py` (cohort z-scores,
  constrained anchor linking with jackknife diagnostics), intervals +
  covariate shrinkage, the capture-discounted value function, fallback
  ladder, decision-stability gate.

Tracks share only frozen schemas; two or three engineers can run them
concurrently with merge points at the end of the phase.

#### Phase 4 — product surface

Build: `sources/aggregates.py` + `sources/preferences.py` (shortlisting
coverage and judge-training data — deferred until now because they inform
no go/no-go decision); `cards.py` (recommendation vs. evidence-report
modes, evidence floors, license-rights stripping, `BenchmarkPanel` preset
emission with the judge-membership constraint resolved); full CLI; the
determinism test.
Exit: cards for the covered slices generated and human-reviewed —
recommendations where evidence permits, evidence reports elsewhere.

#### Phase 5 — full calibration round

Build: `calibration.py` (two-slice design of §15.1; corrected
`CandidateBank` adapter; run-manifest emission). Execute calibration round
1 (the full 150–440-task version of C3's pilot, two slices); measure
`capture(d)` on the estimation slice; implement `validate.py` (selection
regret + fidelity metrics); regenerate cards with calibrated numbers.
Exit: selection-regret gate evaluated per domain; measured capture in
cards; tier-CAL rows in the warehouse; fused-vs-best-single McNemar
artifact produced.

#### Phase 6 — routing and operations

Build: the runtime task labeler (§16 stage 0) and its evaluation; the
rule-based router from cards; the refresh pipeline (re-mine → shortlist
delta → 50–150-task delta calibration → re-issue cards), exercised once
end-to-end on a newly shipped model; the scheduled live-connector job with
volume/drift alerts (CI stays snapshot-only); the identity review-queue
workflow with per-source ownership.

#### What deliberately comes last

Cards polish, CLI ergonomics, aggregate-leaderboard sources, preference
ingestion, and the router are all *behind* the falsification checkpoints on
purpose: each is only valuable if C0–C3 hold, and none de-risks anything.
The learned router (§16 stage 2) is outside this chronology entirely — it
starts only after multiple calibration rounds have accumulated training
data.

Mapping to §20 acceptance gates: M0 = Phase 0, M1 ≈ Phases 1–2, M2 ≈ Phase
3 track A (+identity), M3 ≈ Phase 3 track C (validated in Phase 0), M4 ≈
Phase 4, M5 ≈ Phase 5, M6 ≈ Phase 6. The phases sequence the riskiest
claims first; the acceptance criteria are unchanged except where noted.

### 20. Milestones with acceptance criteria

**M0 — Validation study (gates everything).** The four Phase-0 checkpoints:
deployable-model coverage table (C0), decorrelation existence (C1),
pre-registered selection-beats-average test (C2), and the 50–150-task
same-harness transfer pilot (C3).
*Accept:* all four artifacts produced with recorded pass/fail and the
descope decision (if any) documented. No package code is a deliverable here.

**M1 — Warehouse + first per-task sources.** Package skeleton, schemas
(incl. run identity + license rights), connector framework, the C1-winning
source ported (SWE-bench experiments and/or LLMRouterBench), quality
report, recorded-snapshot tests.
*Accept:* ≥ 10⁴ tier-A/A− outcome rows across ≥ 2 domains; C1/C2 numbers
reproduce deterministically from the package; quality report clean;
`ruff`/`pyright`/`pytest` green.

**M2 — SWE-bench experiments + identity.** S2 ingestion (A− rows +
patch/log URIs), identity table + resolution + review queue,
one-variant-per-engine constraint.
*Accept:* ≥ 10 current systems with pairwise φ computable on ≥ 100 common
SWE-bench instances; unresolved-identity queue < 10% of rows.

**M3 — Analytics + selection.** Constrained normalization/linking with
jackknife diagnostics, intervals + covariate shrinkage, outcome matrices
with φ floors and clustered bootstrap, exhaustive small-K selection with
capture discount + greedy ranked view + fallback ladder +
decision-stability gate.
*Accept:* pre-registered C2-style test reproduces inside the package on
held-out clusters; greedy-vs-exhaustive gap reported; all selection outputs
carry tier/basis labels.

**M4 — Panel cards.** Card generation in both modes (recommendation /
evidence report); emits valid `BenchmarkPanel` presets (judge-membership
constraint resolved); license-rights stripping on export.
*Accept:* every card number carries tier + interval; recommendation mode
only where floors and stability gate pass; thin-coverage domains ship as
evidence reports marked `requires_calibration`; cards render to reviewable
markdown.

**M5 — Calibration round 1 (full).** Two-slice design (stratified-random
estimation + active diagnostic), Layer-2 run via existing harness with
manifest, corrected `CandidateBank` ingest, capture measured on the
estimation slice, §12 selection-regret + fidelity report, cards
regenerated.
*Accept:* selection-regret gate evaluated per domain with clustered CIs;
measured `capture(d)` replaces the prior in cards; tier-CAL rows present;
fused-vs-best-single McNemar artifact produced; per-source bias/variance
estimates (§11.2 reliability regression) published.

**M6 — Runtime labeler + rule router + refresh drill.** The §16 stage-0
task labeler built and evaluated; card-driven routing rules evaluated on a
held-out slice *through the labeler* (not with oracle labels); one full
refresh exercised on a newly shipped model (re-mine → shortlist delta →
50–150-task delta calibration → re-issue cards).
*Accept:* labeler precision/recall per label reported; router regret +
unnecessary-ensemble + missed-opportunity rates reported end-to-end
including labeler error; refresh completed without a full re-run.

### 21. Risk register

| Risk | Mitigation |
|---|---|
| **Public complementarity doesn't transfer to our harness** (the dominant risk: it may be an artifact of scaffold diversity, prompts, or contamination that evaporates under one unified harness) | Checkpoint C3 tests transfer with a small billed pilot *before* the warehouse is built; if it fails, public priors are demoted to task-selection only and the build descopes |
| **Deployable frontier models lack per-task public coverage** (tier-A machinery describes obsolete models) | Checkpoint C0 measures coverage for today's deployable list first; descope to shortlisting+calibration if coverage is absent; cards for uncovered models are evidence reports, never recommendations |
| Public-task contamination inflates priors | Layer separation (priors never back claims); per-model date-windowing on dated sources; §12 fidelity catches systematic inflation; calibration favors post-cutoff tasks |
| Scaffold confounding read as model skill | `scaffold_confounded` flag → tier A−; system-level labeling on every derived number; raw-model attribution only from Layer 2 |
| Identity aliasing fakes diversity | Identity table + resolution + hard one-variant-per-engine constraint; review queue for unknowns |
| Upstream schema drift corrupts silently | Golden-snapshot tests; pure `bytes → rows` parsers; quality report rank-churn check vs. previous snapshot |
| License leakage in exports or training sets | Per-right license model (`can_store/can_export/can_train`); export-time stripping + record of what was stripped; gated sources never in committed snapshots; quality error on violation |
| Simpson's paradox in rollups (difficulty mix differs per model) | All pairwise/oracle math on common-task intersections within strict comparability groups; rollups disclose slice composition |
| Hand-set constants (capture prior, info weights, n_eff discounts) are wrong | Each is replaced by a measured quantity at first opportunity (§12.4, §15.3); until then, sensitivity checks gate decisions that depend on them |
| Judge over-credit (headroom counted as realized) | `capture(d)` discount everywhere; measured, conservative prior before that |
| Sparse-cell overconfidence | Covariate shrinkage + intervals; decision-stability gate; per-cell n floors in calibration design |
| Calibration selection bias (disagreement-enriched slice inflates headroom/capture) | Two-slice design (§15.1): estimates only from the stratified-random slice, with inclusion weights |
| Router misroutes because runtime labels are wrong | Stage-0 labeler is built and measured first; low-confidence labels route to the safe default; labeler error included in regret accounting |
| Steady-state ops cost (parser drift, identity churn, refresh, license reviews) exceeds the value delivered | Per-source owner + maintenance budget + "not refreshed means not used" retirement rule; volume/drift alerts on the scheduled job; §12.4 down-weights sources that mislead so dead sources lose influence automatically |
| Index goes stale | Refresh triggers on cards; delta-calibration path (§20 M6) keeps refresh cheap |

---

## Appendix A — formula reference

```
Wilson interval:        center = (p̂ + z²/2n)/(1 + z²/n)
                        half   = z/(1+z²/n) · √(p̂(1−p̂)/n + z²/4n²)

Beta-binomial shrinkage: p_shrunk = (x + α)/(n + α + β), α,β by method of
                         moments over the cell population of the area

Anchor linking:          minimize Σ (s_{m,b} − μ_b − θ_m)² subject to Σθ_m = 0;
                         identifiable iff model–benchmark overlap graph connected;
                         jackknife (drop-one-benchmark) stability required

Failure φ:               φ = (n11·n00 − n10·n01)/√(n1•·n0•·n•1·n•0);
                         floors: ≥150 common tasks AND ≥20 in every marginal;
                         clustered bootstrap over cluster_key groups

Oracle / headroom:       oracle(S) = mean_t max_{m∈S} y_{m,t}   (submodular)
                         headroom(S) = oracle(S) − max_{m∈S} pass(m)

Panel value:             V(S,d) = best_pass + capture(d)·headroom − λ·cost − μ·latency
Capture:                 capture(d) = (p_fused − p_best_single)
                                      / (p_oracle − p_best_single)   [Layer 2,
                         estimation slice, paired tasks; undefined when
                         headroom ≈ 0]

Selection:               exhaustive over feasible subsets for K ≤ 4 (exact);
                         greedy for the ranked-members view. The classical
                         (1−1/e) guarantee applies to unconstrained
                         cardinality-limited greedy on oracle(S) only — NOT
                         to constrained V(S,d); report greedy-vs-exact gap

Selection regret (gate): Δ(d) = V_cal(best_feasible) − V_cal(index_selected),
                         clustered-bootstrap CI

McNemar (paired A vs B): χ² = (b−c)²/(b+c) over discordant task counts

Task informativeness:    info(t) = 0.30·disagreement + 0.20·entropy
                         + 0.20·undercoverage + 0.15·complementarity
                         + 0.10·traffic − 0.10·runtime − 0.15·flakiness
                         − 0.20·license_risk
                         (diagnostic slice ONLY, weight-stability checked;
                         estimates come from the stratified-random slice)

Sample-size guide (95% worst-case margin on a binary rate):
                         n=25 → ±20pp   n=50 → ±14pp   n=100 → ±10pp   n=400 → ±5pp
```

## Appendix B — glossary

- **Capability index**: versioned warehouse of task-level benchmark evidence
  plus derived per-model/per-subdomain beliefs with confidence and
  provenance.
- **Comparability group**: outcome rows sharing benchmark, version, harness,
  evaluator, attempt budget, and prompting mode; the only unit within which
  correlation math is allowed.
- **Oracle**: hypothetical panel success if a perfect judge always picked
  the best member's answer; the panel ceiling.
- **Headroom**: oracle minus best member; what fusion can possibly add.
- **Capture rate**: fraction of *headroom* a real judged ensemble realizes,
  `(p_fused − p_best_single)/(p_oracle − p_best_single)`; measured per
  domain in Layer 2 on the estimation slice; undefined when headroom ≈ 0.
- **Evidence tier**: A / A− / B / C / D / E / CAL; what a row is allowed to
  influence (§4).
- **Scaffold-confounded**: an outcome measuring model+agent-system, not the
  raw model (tier A− at best).
- **Panel card**: the versioned product artifact answering "which K models,
  and why" for one subdomain, with tiers and intervals on every number.
- **Lopsided panel**: one member dominates; headroom ≈ 0; fusion adds cost,
  not quality.
- **Router regret**: value of the best possible route minus the route the
  router chose, decomposed into unnecessary-ensemble and missed-opportunity
  rates.
