# Coding Capability Index — Implementation Specification

**Status:** proposal, ready to implement
**Audience:** an engineer with no prior context on this project
**Deliverable:** a Python workspace package (`capability-index`) plus
integration glue into the existing `fusionkit-evals` benchmark stack

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
  public sources ──▶│ sources/     (SourceSpec registry, parsers) │
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
  snapshots/                     # recorded real payloads for parser tests
    livecodebench_generation.2026-07.json      (committed, truncated)
    swebench_experiments.2026-07.sample.json
  src/capability_index/
    __init__.py                  # public API re-exports
    __main__.py
    cli.py
    models.py                    # all pydantic schemas (§7)
    taxonomy.py                  # label enums + source→taxonomy maps (§8)
    registry.py                  # SourceSpec registry (§9.1)
    sources/
      __init__.py
      livecodebench.py           # per-question outcomes (tier A)
      livebench.py               # per-question outcomes (tier A)
      bigcodebench.py            # per-sample outcomes (tier A)
      swebench_experiments.py    # per-instance outcomes (tier A−)
      llmrouterbench.py          # bulk instance outcomes (tier A/B)
      terminal_bench.py          # trajectory outcomes (tier A−)
      aggregates.py              # Aider/OpenLLM/BenchLM/AA (tier E/B)
      preferences.py             # WebDev-Arena-style pairs (tier C)
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
License = Literal["permissive", "research_only", "restricted", "unknown"]
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
    task_fingerprint: str | None = None  # sha256 of prompt+repo snapshot when
                                         # obtainable; links task across versions
    # Taxonomy (§8)
    primary_domain: str
    task_operation: str
    language: str
    context_flags: list[str] = Field(default_factory=list)
    framework: str | None = None
    difficulty_source: str | None = None    # source-provided label if any
    difficulty_empirical: float | None = None  # 1 − mean pass rate, computed

    # Provenance & governance
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str                 # ISO 8601
    license: License = "unknown"
    # Artifact pointers (never inlined; URIs into object storage or upstream)
    prompt_uri: str | None = None
    gold_patch_uri: str | None = None      # NEVER shown to any solver/judge
    gold_tests_uri: str | None = None      # NEVER shown to any solver/judge
```

Key: `(benchmark, benchmark_version, task_id)`.

#### 7.2 `TaskOutcome` — the evidence spine

One row per (task, system, attempt-policy) observation. "System" means
model-under-scaffold; the identity facets make the distinction explicit.

```python
class TaskOutcome(BaseModel):
    # Task key
    benchmark: str
    benchmark_version: str
    task_id: str

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
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str
    license: License = "unknown"
```

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
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str
    license: License = "unknown"
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
    source_url: str
    source_snapshot_hash: str
    retrieved_at: str
    license: License = "unknown"
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
4. **Clustering refines, never defines.** It is tempting to embed prompts
   and cluster them into a taxonomy. Don't: that clusters by benchmark
   source and prompt style, not by routing-relevant capability. Use
   clustering only *after* labeled results exist, to propose splits (e.g.
   `frontend_ui` → component-logic vs. css-layout) where model rankings
   demonstrably differ inside a cell — then apply rule 3 to the proposal.

### 9. Source ingestion (Layer 1)

#### 9.1 The registry

Every source is a `SourceSpec` registered in one registry; the fetch loop is
generic. Adding a source never touches the loop.

```python
# src/capability_index/registry.py
from __future__ import annotations

import hashlib
import urllib.request
from collections.abc import Callable, Sequence
from datetime import datetime, timezone

from pydantic import BaseModel

from capability_index.models import AggregateScore, BenchmarkTask, TaskOutcome


class ParseResult(BaseModel):
    tasks: list[BenchmarkTask] = []
    outcomes: list[TaskOutcome] = []
    aggregates: list[AggregateScore] = []


Parser = Callable[[bytes, str, str, str], ParseResult]
# (payload, source_url, snapshot_hash, retrieved_at) -> ParseResult


class SourceSpec(BaseModel):
    source: str                       # registry key, e.g. "livecodebench_generation"
    url: str
    parser: Parser
    emits_tiers: tuple[str, ...]      # e.g. ("A",) — validated against rows
    emits_domains: tuple[str, ...]    # taxonomy domains this source may label
    license: str
    description: str

    model_config = {"arbitrary_types_allowed": True}


_REGISTRY: dict[str, SourceSpec] = {}


def register_source(spec: SourceSpec) -> None:
    if spec.source in _REGISTRY:
        raise ValueError(f"duplicate source {spec.source!r}")
    _REGISTRY[spec.source] = spec


def get_source_specs() -> list[SourceSpec]:
    return sorted(_REGISTRY.values(), key=lambda spec: spec.source)


def fetch_source(spec: SourceSpec, *, timeout_s: float = 60.0) -> ParseResult:
    with urllib.request.urlopen(spec.url, timeout=timeout_s) as response:
        payload = response.read()
    snapshot_hash = hashlib.sha256(payload).hexdigest()
    retrieved_at = datetime.now(timezone.utc).isoformat()
    return spec.parser(payload, spec.url, snapshot_hash, retrieved_at)
```

Fetch policy: **tolerant by default** — one source failing (site down, schema
drift) records a `SourceFetchResult(availability="failed", error=...)` and
the run continues; `--strict` turns any failure into a non-zero exit for CI.
CI never scrapes live: parser tests run against committed recorded payloads
(`snapshots/`); a separate scheduled job exercises live fetches.

#### 9.2 Per-source specifications

Ordered by information value. "Volume" = order-of-magnitude `TaskOutcome`
rows obtainable.

**S1. LiveCodeBench per-question results — tier A, volume 10⁴.**
LiveCodeBench (github.com/LiveCodeBench/LiveCodeBench) publishes per-question
results for four scenarios (code generation, self-repair, execution, test
output prediction) as JSON files with entries like
`{"question_id": ..., "model": ..., "difficulty": ..., "pass@1": ...}`. All
models ran under the official harness, so within one scenario+version these
are same-harness per-task outcomes — the best kind of public evidence.
Parser: emit one `TaskOutcome` per (question, model) with
`harness="livecodebench-official"`, `scoring="deterministic_tests"`,
`tier="A"`, `scaffold_confounded=False`; also emit one `BenchmarkTask` per
question (`primary_domain="algorithmic"`, operation by scenario:
generation→`greenfield`, repair→`bugfix_debug`, testgen→`test_generation`;
`language="python"`; `context_flags=["single_file"]`; difficulty from the
source field). **Contamination control:** record `contest_date` per question;
when computing any model's cells, only questions dated after the model's
release window count as uncontaminated (release dates live in the identity
table, §10). Also emit per-model `AggregateScore` rollups (tier B) for
display continuity.

**S2. SWE-bench experiments — tier A−, volume 10⁴–10⁵.**
The repository github.com/swe-bench/experiments holds every leaderboard
submission: per-instance `resolved/unresolved` results, `all_preds.jsonl`
(patches), execution logs, and often full agent trajectories, per submission
directory with `metadata.yaml`. Parser: one `TaskOutcome` per (instance,
submission) with `model_key` = submission name, `base_model_key` parsed from
metadata, `harness_or_agent` = scaffold from metadata,
`scaffold_confounded=True` (tier A−), `harness="swebench-official-eval"`,
`scoring="deterministic_tests"`; patch/log URIs recorded. `BenchmarkTask`
rows come from the SWE-bench dataset itself (`primary_domain="repo_bugfix"`,
`language` from repo, `context_flags=["multi_file_repo","tool_required"]`,
refined labels from touched-file paths per §8 rule 1). This source is the
single largest complementarity dataset in existence for repo-level coding;
its A− tier means: correlations computed here describe *systems*
(model+scaffold), which is honest — flag it on every derived number.

**S3. LiveBench per-question rows — tier A, volume 10⁴.**
LiveBench (livebench.ai) exposes per-question model judgments through the
Hugging Face datasets server
(`https://datasets-server.huggingface.co/rows?dataset=livebench/...`), rows
like `{"question_id", "task", "category", "model", "score"}`. Same-harness by
construction. Parser: `TaskOutcome` per row, `tier="A"`,
`scoring="llm_judge"` for judged categories (which widens intervals, §11.2);
map categories → taxonomy (`coding`→`algorithmic`,
`data_analysis`→`data_sql`, reasoning categories → keep as shortlisting-only
aggregates since they're not coding).

**S4. BigCodeBench pre-generated samples — tier A, volume 10⁴–10⁵.**
BigCodeBench (github.com/bigcode-project/bigcodebench) publishes 1,140
practical library-usage tasks *and* pre-generated samples + execution results
for dozens of models under the official harness. Parser: `TaskOutcome` per
(task, model) with `tier="A"`, `scoring="deterministic_tests"`;
`BenchmarkTask` rows labeled by the libraries each task imports
(pandas/numpy/sqlite → `data_sql`; requests/flask → `backend_api_db`; else
`algorithmic`), `language="python"`,
`context_flags=["single_file","tool_required"]` per task metadata.

**S5. LLMRouterBench — tier A/B, volume 10⁵.**
github.com/ynulihao/LLMRouterBench standardizes per-instance outcomes for
~33 models across 21+ datasets (400K+ instances) with prompt, prediction,
score, tokens, cost. Ingest its coding subsets (HumanEval/MBPP → 
`algorithmic+single_file`; LiveCodeBench → as S1; SWE-bench → as S2). Group
strictly by its per-dataset harness field: cross-dataset rows never share a
comparability group. Beyond ingestion, this dataset is the **offline testbed
for our selection math** (§11.4 acceptance test): it is large enough to
compare greedy top-K panels against exhaustive-search optima.

**S6. Terminal-Bench trajectories — tier A−, volume 10³.**
HF dataset `yoonholee/terminalbench-trajectories` (and the tbench.ai
leaderboard) provide per-task agent outcomes with step-level traces, cost,
duration. Parser: `TaskOutcome` per (task, agent-run), `
scaffold_confounded=True`, domain `devops_terminal`; derive trajectory
features (failed-command count, repeated-command loops, timeout flags) into
task difficulty metadata — these become router features later.

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

**S9. WebDev Arena preference pairs — tier C.**
HF dataset `lmarena-ai/webdev-arena-preference-10k`: pairwise human votes on
generated web apps. Parser: `PairwisePreference` rows. Purpose: judge
training/eval for frontend (§15.4). **License gate:** check the dataset
license before any redistribution; rows marked `restricted` are usable for
internal training but stripped from every exported artifact (§13).

Parser engineering notes, applying to all sources:

- Each parser is a pure function `bytes -> ParseResult`; no network inside
  parsers. This makes golden-snapshot testing trivial.
- Every parser gets a **golden-snapshot test**: a recorded real payload
  (truncated to a few hundred rows, committed under `snapshots/`) plus
  assertions on exact parsed values. Synthetic-fixture tests validate logic;
  golden tests catch upstream schema drift, which is the actual failure mode
  of scrapers.
- HTML scraping (Aider) is the most brittle; prefer JSON/CSV endpoints
  everywhere they exist, and treat scraped sources as tier-E shortlisting
  input only, so drift can't corrupt anything decision-critical.

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
  seeds known models. Ingestion normalizes: lowercase, strip provider
  prefixes, extract effort suffixes (`-high`, `(high)`, `-thinking` →
  `reasoning_effort`), extract date suffixes (`-2026-05` →
  `provider_model_id`).
- Rows whose `model_key` cannot be resolved get
  `base_model_key=None` and land in a **review queue** emitted by the data
  quality report; unresolved models are excluded from panel selection (they
  may still appear in shortlists, flagged).
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

by least squares over observed (model, benchmark) pairs — `θ_m` is the
model's area ability, `μ_b` the benchmark offset. This is solvable exactly
when the model–benchmark bipartite overlap graph is **connected** (some
models appear on both benchmarks, transitively). That condition is also the
honest one: if two benchmarks share no models, refuse to merge their scales
and keep separate columns with an explicit warning.

```python
# normalize.py — anchor linking sketch (pure stdlib; ~40 lines with checks)
def fit_anchor_link(
    observations: list[tuple[str, str, float]],  # (model, benchmark, z_score)
) -> tuple[dict[str, float], dict[str, float]]:
    """Solve least squares for theta_m (model ability) and mu_b (benchmark
    offset) via alternating means; converges because the problem is a
    two-factor additive model. Raise if the overlap graph is disconnected."""
    _assert_connected(observations)
    theta: dict[str, float] = {}
    mu: dict[str, float] = {}
    for _ in range(200):
        mu = _means_by(observations, key="benchmark", residual_of=theta)
        new_theta = _means_by(observations, key="model", residual_of=mu)
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

**Empirical-Bayes shrinkage** toward the area mean, so sparse cells don't
produce extreme point estimates: fit a beta-binomial over the population of
cells in an area (method of moments for `α, β`), then
`p_shrunk = (x + α)/(n + α + β)`.

**Tier and scoring-mode effects are precision modifiers, not score
multipliers.** A tier-B row or an `llm_judge`-scored row doesn't get its
score scaled down (that silently corrupts the estimate); it gets its
*effective n* discounted (e.g. `n_eff = n × 0.5` for llm_judge, `× 0.35` for
mixed-harness tier B), which widens the interval. Rows with unknown `n` get a
fixed wide interval. Cells whose interval spans more than 40 points are
labeled `insufficient_evidence` and excluded from selection.

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

Within a group, build the binary matrix `y[m][t] ∈ {0,1}` (threshold scores
at 1.0 for pass@1-style data; keep fractional for partial-credit sources and
use the fractional generalizations below).

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

def failure_phi(y, a: str, b: str, min_common: int = 30) -> float | None:
    """Phi coefficient between failure indicators of two models.
    Returns None (refuse) below min_common common tasks."""
    common = sorted(set(y[a]) & set(y[b]))
    if len(common) < min_common:
        return None
    fa = [1 - int(y[a][t] >= 1.0) for t in common]
    fb = [1 - int(y[b][t] >= 1.0) for t in common]
    n11 = sum(x and z for x, z in zip(fa, fb))
    n00 = sum((not x) and (not z) for x, z in zip(fa, fb))
    n10 = sum(x and (not z) for x, z in zip(fa, fb))
    n01 = sum((not x) and z for x, z in zip(fa, fb))
    denom = math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
    return ((n11 * n00) - (n10 * n01)) / denom if denom else None
```

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

Report Wilson intervals on oracle/headroom via bootstrap over tasks (1,000
resamples is plenty; it's a mean of maxima).

#### 11.4 Panel selection: top-K from N

**The objective.** A judged panel does not collect the oracle: the judge
picks wrong sometimes. Model the realized value of panel `S` in domain `d`:

```
V(S, d) = best_pass(S, d) + capture(d) × headroom(S, d) − λ·cost(S) − μ·latency(S)
```

where `capture(d) ∈ [0,1]` is the fraction of headroom a judged ensemble
actually realizes in that domain. Before Layer-2 data exists, use a
conservative prior `capture = 0.7`; after the first calibration round,
replace it with the measured value
`judged_ensemble_success / oracle_success` from our own runs (§15.3).

**The algorithm.** `oracle(S)` is a coverage function — monotone submodular
in `S` — so lazy greedy selection by marginal gain carries the classical
(1 − 1/e) approximation guarantee. Greedy is also exactly what we want
operationally: it yields a ranked list of members with attributable marginal
value.

```python
# select.py — sketch
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
cards:

1. **Ranking fidelity** — Spearman ρ between the index's predicted
   per-domain model ranking and the calibrated ranking on the same model
   set. Gate: ρ ≥ 0.7 in a domain before index rankings may auto-seed
   default panels there without human review.
2. **Probability calibration** — Brier score of predicted P(pass) per
   model×domain against calibrated outcomes.
3. **Complementarity fidelity** — |predicted headroom(S) − measured
   headroom(S)| for the selected panel, and sign agreement between predicted
   and measured pairwise φ.
4. **Prior→posterior movement** — per source, how much cells moved when
   calibrated evidence arrived. Sources that consistently mislead get their
   `n_eff` discount increased; this is how hand-set precision constants get
   replaced by measured ones over time.

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
- **license**: `restricted` rows present in an export-bound artifact. Export
  functions (`cards.py`, snapshot publishing) strip restricted rows and
  record what was stripped; internal selection may still use them.

Provenance invariants: every row carries
`source_url + source_snapshot_hash + retrieved_at`; every derived artifact
records the input snapshot hashes and the git SHA of the code that built it.
Rebuilding an artifact from the same snapshots must be byte-identical
(sort all outputs; no timestamps inside derived artifacts except a top-level
`generated_at`).

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

- Every number carries its tier; the card's `evidence_floor` is the minimum.
- Complementarity claims (φ, headroom, unique wins) require floor ≥ A−; a
  card that can't meet that prints the shortlist with
  `selection_basis: aggregate_proxy` and *no* complementarity numbers.
- Cards also emit a machine-readable panel preset consumable by the Layer-2
  bench runner (`fusionkit_evals.benchmark_panel.BenchmarkPanel`: members
  with provider/base_url/key-env, judge id, synthesizer id) so "run the
  card's panel" is one command.

### 15. Layer 2: calibration

Layer 1 predicts; Layer 2 verifies, on our own harness, with our own money,
on a slice chosen to maximize information per dollar.

#### 15.1 Choosing the calibration slice

Never sample tasks randomly. For each candidate task, using the mined public
outcome matrix restricted to the shortlisted models, compute:

```
disagreement(t)  = variance of pass across shortlisted models on t
entropy(t)       = binary entropy of mean pass on t
undercoverage(t) = 1 if t's taxonomy cell is below its target n in the slice
complementarity(t) = 1 if t is a unique-win task for some shortlist pair
```

and score:

```
info(t) = 0.30·disagreement + 0.20·entropy + 0.20·undercoverage
        + 0.15·complementarity + 0.10·traffic_relevance
        − 0.10·runtime_estimate − 0.15·flakiness_risk − 0.20·license_risk
```

Take the top 150–440 tasks across the 3–4 domains with the densest public
coverage (`repo_bugfix`, `algorithmic`, `data_sql`, `devops_terminal`), with
per-cell floors (≥ 30/cell for directional signal; ≥ 100/cell where we need
routing-grade confidence). Exclude tasks that *all* or *no* public models
solve (zero routing information), and tasks with flaky grading.

**Weight-stability check:** re-run selection under ±50% perturbation of the
`info` weights; require ≥ 80% overlap in the selected set. If selection is
weight-fragile, the slice is arbitrary — widen it or fix the inputs.

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

The bench runner freezes results into a `CandidateBank` (per-task,
per-model pass flags + candidate outputs). Write a small adapter:

```python
# calibration.py
from fusionkit_evals.candidate_bank import CandidateBank

from capability_index.models import TaskOutcome


def bank_to_outcomes(bank: CandidateBank, *, harness: str) -> list[TaskOutcome]:
    rows: list[TaskOutcome] = []
    for task in bank.tasks:
        for model_id, passed in task.pass_by_model.items():   # per-candidate flags
            rows.append(TaskOutcome(
                benchmark="calibration",
                benchmark_version=bank.signature,
                task_id=task.task_id,
                model_key=model_id,
                harness=harness,
                scoring="deterministic_tests",
                passed_or_score=1.0 if passed else 0.0,
                tier="CAL",
                layer="calibrated",
                scaffold_confounded=False,
                source_url="internal://candidate-bank",
                source_snapshot_hash=bank.signature,
                retrieved_at=_now(),
                license="permissive",
            ))
    return rows
```

(Adjust field access to the actual `BankTask` shape; note that
`fusionkit_evals` also defines an unrelated `TaskOutcome` *Literal* type —
alias imports to avoid the collision.)

These tier-CAL rows flow into the same warehouse and the same analytics;
`capture(d)` gets measured (`judged_ensemble_success / oracle_success` from
the judge decision log); §12 fidelity metrics get computed; cards get
regenerated with calibrated numbers where available.

Additionally, run the existing diagnostics on the bank —
`fusion_hillclimb.diagnose_bank()` (oracle ceiling, best single, mean failure
correlation, lopsidedness) and
`fusion_compound.compare_compound_vs_individual()` (fused vs. best single
with paired McNemar) — these are the numbers that back any public claim.

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
cheap-first-escalate. Build it in two stages and resist skipping stage 1:

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
  malformed tiers/layers.
- **Golden-snapshot parser tests** (the critical ones): recorded real
  payloads under `snapshots/`, exact-value assertions. When an upstream
  schema drifts, this test fails loudly instead of numbers drifting quietly.
- **Analytics unit tests with hand-computable cases**: e.g. the 3-model,
  3-task matrix where gemini uniquely wins t3 → `oracle = 1.0`,
  `unique_win(gemini) = 1/3`, `φ(gpt, opus) = −0.5`; verify greedy picks the
  complementary pair over two look-alike high scorers.
- **Selection acceptance test on LLMRouterBench**: greedy top-K panels reach
  ≥ 90% of exhaustive-search oracle gain for K ≤ 3 on held-out coding
  subsets, and selection is ≥ 80% stable under task bootstrap.
- **Determinism test**: same snapshots in → byte-identical artifacts out.
- **Quality-gate test**: seeded bad rows (duplicate, undeclared domain,
  restricted-license in export) each trigger their check.

### 19. Milestones with acceptance criteria

**M1 — Warehouse + first tier-A sources.** Package skeleton, schemas,
registry, LiveCodeBench + LiveBench + BigCodeBench parsers (per-question →
`TaskOutcome`), quality report, golden tests.
*Accept:* ≥ 10⁴ tier-A outcome rows across ≥ 2 domains; quality report
clean; `ruff`/`pyright`/`pytest` green.

**M2 — SWE-bench experiments + identity.** S2 ingestion (A− rows +
patch/log URIs), identity table + resolution + review queue,
one-variant-per-engine constraint.
*Accept:* ≥ 10 current systems with pairwise φ computable on ≥ 100 common
SWE-bench instances; unresolved-identity queue < 10% of rows.

**M3 — Analytics + selection.** Normalization/linking, intervals/shrinkage,
outcome matrices, greedy selection with capture discount + fallback ladder.
*Accept:* LLMRouterBench acceptance test passes (≥ 90% of exhaustive oracle
gain, ≥ 80% bootstrap stability); all selection outputs carry
tier/basis labels.

**M4 — Panel cards.** Card generation for the 3–4 densest slices; emits
`BenchmarkPanel` presets; license stripping on export.
*Accept:* every card number carries tier + interval; complementarity floors
enforced (≥ A−); cards render to reviewable markdown.

**M5 — Calibration round 1.** Informativeness slice (with weight-stability
check), Layer-2 run via existing harness with manifest, `CandidateBank`
ingest, capture measurement, §12 fidelity report, cards regenerated.
*Accept:* Spearman ρ reported per domain; measured `capture(d)` replaces the
prior in cards; tier-CAL rows present; fused-vs-best-single McNemar artifact
produced.

**M6 — Rule router + refresh drill.** Card-driven routing rules evaluated on
a held-out slice; one full refresh exercised on a newly shipped model
(re-mine → shortlist delta → 50–150-task delta calibration → re-issue cards).
*Accept:* router regret + unnecessary-ensemble + missed-opportunity rates
reported; refresh completed without a full re-run.

### 20. Risk register

| Risk | Mitigation |
|---|---|
| Public-task contamination inflates priors | Layer separation (priors never back claims); per-model date-windowing on dated sources; §12 fidelity catches systematic inflation; calibration favors post-cutoff tasks |
| Scaffold confounding read as model skill | `scaffold_confounded` flag → tier A−; system-level labeling on every derived number; raw-model attribution only from Layer 2 |
| Identity aliasing fakes diversity | Identity table + resolution + hard one-variant-per-engine constraint; review queue for unknowns |
| Upstream schema drift corrupts silently | Golden-snapshot tests; pure `bytes → rows` parsers; quality report rank-churn check vs. previous snapshot |
| License leakage in exports | Hard license field; export-time stripping + record of what was stripped; quality error on violation |
| Simpson's paradox in rollups (difficulty mix differs per model) | All pairwise/oracle math on common-task intersections within strict comparability groups; rollups disclose slice composition |
| Hand-set constants (capture prior, info weights, n_eff discounts) are wrong | Each is replaced by a measured quantity at first opportunity (§12.4, §15.3); until then, sensitivity checks gate decisions that depend on them |
| Judge over-credit (headroom counted as realized) | `capture(d)` discount everywhere; measured, conservative prior before that |
| Sparse-cell overconfidence | Shrinkage + intervals; `insufficient_evidence` exclusion; per-cell n floors in calibration design |
| Index goes stale | Refresh triggers on cards; delta-calibration path (§19 M6) keeps refresh cheap |

---

## Appendix A — formula reference

```
Wilson interval:        center = (p̂ + z²/2n)/(1 + z²/n)
                        half   = z/(1+z²/n) · √(p̂(1−p̂)/n + z²/4n²)

Beta-binomial shrinkage: p_shrunk = (x + α)/(n + α + β), α,β by method of
                         moments over the cell population of the area

Anchor linking:          minimize Σ (s_{m,b} − μ_b − θ_m)² over observed pairs;
                         identifiable iff model–benchmark overlap graph connected

Failure φ:               φ = (n11·n00 − n10·n01)/√(n1•·n0•·n•1·n•0), n ≥ 30

Oracle / headroom:       oracle(S) = mean_t max_{m∈S} y_{m,t}   (submodular)
                         headroom(S) = oracle(S) − max_{m∈S} pass(m)

Panel value:             V(S,d) = best_pass + capture(d)·headroom − λ·cost − μ·latency
Capture:                 capture(d) = judged_success(d)/oracle_success(d)  [Layer 2]

Greedy guarantee:        lazy greedy on monotone submodular oracle ≥ (1−1/e)·OPT

McNemar (paired A vs B): χ² = (b−c)²/(b+c) over discordant task counts

Task informativeness:    info(t) = 0.30·disagreement + 0.20·entropy
                         + 0.20·undercoverage + 0.15·complementarity
                         + 0.10·traffic − 0.10·runtime − 0.15·flakiness
                         − 0.20·license_risk   (weight-stability checked)

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
- **Capture rate**: fraction of headroom a real judged ensemble realizes;
  measured per domain in Layer 2.
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
