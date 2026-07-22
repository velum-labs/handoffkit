# Lab Loop Implementation Spec (2026-07)

> **Superseded by [Hyperkit](../hyperkit.md).** The clean-break extraction
> deletes `python/fusionkit-lab` and moves its generic registry/orchestration
> responsibilities into the SUT-agnostic `python/hyperkit` platform. Fusion
> candidate banks, prompt tuning, and hill-climb logic remain in
> `fusionkit-evals` as Hyperkit consumers. This document is retained as the
> historical staged design; `docs/hyperkit.md` is the implemented architecture.

**Status:** approved-for-implementation spec, drafted 2026-07-06. No code yet.
**Reader:** the engineer implementing the lab loop. Assumes you have read
`lab-loop-2026-07.md` (the process this code automates). This document says
*what to build, in what order, and how we know each stage is done*.
**Scope:** everything needed to run one full lab cycle (Steps 0–6 of the
process doc) as code, for the working portfolio: repo bugfix, test
generation, SQL, and algorithmic-as-testbed.

---

## 0. Architecture decisions (fixed for this spec)

### 0.1 Where the code lives

| Layer | Location | Rationale |
|---|---|---|
| Orchestration (the loop itself) | **New uv workspace member `python/fusionkit-lab/`**, package `fusionkit_lab`, console script `fklab` | One CLI replaces the copy-pasted `analysis/*/scripts/*.py` runners; stays in this monorepo because it must evolve with the harness and the shipped ensemble configs |
| Graders, sandbox, stats, replay primitives | **`python/fusionkit-evals/`** (existing; extended, not forked) | Already works for algorithmic; the product and the lab must share one grading truth |
| Run artifacts (banks, outcomes, ledgers, logs) | **`labdata/` at repo root, gitignored**, overridable via `FUSIONKIT_LAB_ROOT` | The `analysis/` pattern of committing caches does not scale; artifacts are outputs, not source |
| Committed per-run records | `labruns/<cycle>/<domain>/…` — preregistrations, run manifests (hashes + summary numbers), reports | Small, auditable, append-only; the git history *is* the round-immutability mechanism |
| Confirm task banks | **Outside this repo** (private bucket or private repo), referenced by manifest + sha256 | Sealed means sealed: not readable by the code path that does Step-4 search |

`analysis/` is frozen as historical record. New experiments run through
`fklab`; nothing new is added under `analysis/`.

### 0.2 What `fusionkit-evals` keeps vs what `fusionkit-lab` adds

`fusionkit-evals` (library, no long-lived state): task/grader schemas, the
grader implementations, sandbox, code extraction, stats
(`bench_stats`, `prompt_tuning.mcnemar`), replay/selection primitives
(`exec_select`, `fusion_hillclimb.diagnose_bank`), provenance.

`fusionkit-lab` (application, owns state): model registry, bucket/bank
storage, the step runners (sweep, fill, search, confirm), spend ledger and
budget guard, preregistration gating, evidence-card and archive generation.

Dependency direction: `fusionkit-lab → fusionkit-evals → fusionkit-core`.
Never the reverse.

### 0.3 Non-goals (explicitly out of this spec)

- The router (we only *archive* its future training data — Stage 7).
- Production gateway telemetry (separate work item, G3 in the operating doc).
- Serving the confirmed ensembles (`.fusionkit/` config output is the
  handoff point to the existing product surface).
- Web UI of any kind. Everything is CLI + committed markdown/JSON.

### 0.4 Global engineering rules

- Python 3.11+, pydantic models for every persisted record, ruff + pyright
  clean under the existing root config (add `python/fusionkit-lab` to the
  pyright `include` list).
- **No billed API calls in CI.** Every runner accepts a `ProviderClient`
  interface; unit tests use a deterministic fake. Billed smoke tests are
  manual, gated on the relevant `*_API_KEY` env vars, and always run with
  `--max-spend`.
- Every long run is **resumable**: state is flushed incrementally (the
  thinking-32k runner already does this; the pattern is kept).
- Every billed run writes a **spend ledger** (JSONL, one row per API call)
  and enforces a **hard budget cap** — abort, don't overrun.
- All persisted artifacts carry **provenance** via the existing
  `fusionkit_evals.provenance.build_provenance` (repo SHA, package versions,
  prompt hashes, dataset revisions).

---

## 1. The stages at a glance

Two tracks. Track A is the domain-agnostic loop engine, strictly ordered.
Track B is per-domain graders and harvesters; each Track B stage depends
only on Stage 2's grader interface and can run in parallel with Stages 3–7.

```
TRACK A (the engine)                        TRACK B (domains)
Stage 0  package scaffold + model registry
Stage 1  core schemas + storage
Stage 2  grader framework + algorithmic     ──► interface freeze
Stage 3  screen sweep runner  (Step 2)      Stage 8   repo-bugfix grader   ← launch bottleneck
Stage 4  bank filler          (Step 3)      Stage 9   test-gen mutation grader
Stage 5  offline search       (Step 4)      Stage 10  SQL grader
Stage 6  confirm runner       (Step 5)      Stage 11  task harvesters
Stage 7  packaging + archive  (Step 6)
```

Milestone gates:

- **M1 (end Stage 4):** a full Screen→Select cycle runs end-to-end on the
  algorithmic domain with real money, replacing the `analysis/` scripts.
- **M2 (end Stage 7):** a complete cycle — including a sealed Confirm run
  and a generated evidence card — on the algorithmic domain.
- **M3 (Stage 8 done):** the same complete cycle on repo bugfix. This is
  the launch-blocking milestone.

---

## 2. Stage 0 — Package scaffold and model registry

**Goal:** `fklab` exists, is installable in the workspace, and can describe
pinned model identities and lab configuration. Zero API calls.

### Deliverables

```
python/fusionkit-lab/
  pyproject.toml            # workspace member; deps: fusionkit-evals, fusionkit-core, pydantic, click/argparse
  src/fusionkit_lab/
    __init__.py
    cli.py                  # `fklab` entry point; subcommand skeleton
    config.py               # LabConfig: labdata root, cycle id, budget defaults
    registry.py             # model registry (below)
  registry/                 # committed YAML, one file per cycle
    2026-q3.yaml
```

### The model registry (`registry.py`)

Encodes the two standing shortlist rules (pinned identity, lineage veto)
as data, replacing the per-script `EndpointSpec` dicts in `analysis/`:

```python
class ModelIdentity(BaseModel):
    endpoint_id: str          # short handle used everywhere downstream, e.g. "r1"
    provider: str             # "openrouter", "openai", ...
    model: str                # provider-side model string, pinned
    base_url: str
    api_key_env: str
    input_price_per_m: float  # USD, for the estimated-cost fallback
    output_price_per_m: float
    max_completion_tokens: int          # default budget (32k) …
    escalated_completion_tokens: int | None  # … and the 64k thinking rung
    lineage: list[str]        # base model / teacher tags for the veto
    generation: str           # e.g. "2026-h1"; bridge models carry the older tag
```

Registry-level helpers: `identity_hash(model)` (sha256 of the pinned
fields — this hash appears in every downstream artifact so a silent
provider swap is detectable), and `lineage_conflicts(a, b) -> bool`.

### CLI skeleton

`fklab models list`, `fklab models show <endpoint_id>`, `fklab config` —
read-only commands proving the plumbing works.

### Definition of done

- `uv sync --all-packages` picks up the member; `uv run --package
  fusionkit-lab fklab models list` prints the 2026-q3 registry.
- Unit tests: registry parsing, identity hash stability, lineage veto.
- `uv run ruff check .` and `uv run pyright` green with the new package in scope.

---

## 3. Stage 1 — Core schemas and storage

**Goal:** every record the loop ever writes has a typed schema and a
storage location, before any runner exists. This is the stage to get
right; everything else is plumbing around these types.

### Deliverables (`fusionkit_lab/schemas/` + `fusionkit_lab/store.py`)

#### 3.1 `TaskRecord` — one task, any domain, any bucket

The JSON skeleton from the process doc §1e, as pydantic:

```python
class TaskRecord(BaseModel):
    task_id: str              # "<domain>:<slug>", globally unique
    domain: Domain            # enum: repo_bugfix | test_generation | data_sql | algorithmic
    bucket: Bucket            # enum: screen | select | confirm
    source: str               # "harvested:github/NodeBB@2026-05" | "adapted:swe-bench-pro" | ...
    created_at: date          # load-bearing: contamination proof + rotation
    prompt: str               # never contains the gold answer
    grader: GraderSpec        # discriminated union, Stage 2
    metadata: TaskMetadata    # language, difficulty_class, categories — the router's future features
```

#### 3.2 `TaskBank` — a bucket's manifest

A bank file is JSONL of `TaskRecord` plus a small committed manifest:
`bank_id`, `domain`, `bucket`, `n_tasks`, `content_sha256`, `created_at`
range, source breakdown. **Confirm manifests are committed; Confirm JSONL
content is not** (it lives at a URI in the manifest, fetched only by the
Stage-6 runner).

#### 3.3 `SampleRecord` / `SampleBank` — candidate bank v2

The existing `fusionkit_evals.candidate_bank.CandidateBank` stores one
`{model_id, content, passed}` per model. The lab needs K samples with
economics and validity flags:

```python
class SampleRecord(BaseModel):
    task_id: str
    endpoint_id: str
    identity_hash: str        # from the registry — pins model+provider+config
    sample_index: int         # 0..K-1
    status: Literal["succeeded", "failed", "truncated"]
    content: str
    content_sha256: str       # content-addressing for dedupe/audit
    passed: bool | None       # None when the grader could not run
    grade_detail: dict        # grader-specific (tests passed/failed, kill rate, ...)
    prompt_tokens: int | None
    completion_tokens: int | None
    charged_cost_usd: float | None
    estimated_cost_usd: float | None
    latency_s: float | None
    error_message: str | None
    sampling: dict            # temperature, max_tokens actually used
```

`SampleBank` = header (bank signature over endpoints + sampling + prompt
template, reusing the `bank_signature` idea) + JSONL of `SampleRecord`.
Stored under `labdata/`, addressed by signature.

A thin **adapter** converts a `SampleBank` slice (one sample per model) to
the existing `CandidateBank` so `fusion_hillclimb.diagnose_bank` and the
prompt-tuning machinery work unchanged in Stage 5.

#### 3.4 `SpendLedger` and `BudgetGuard`

JSONL rows: `{ts, run_id, phase, task_id, endpoint_id, provider, model,
status, prompt_tokens, completion_tokens, charged_cost_usd,
estimated_cost_usd, error_message}` — the union of what the
`analysis/thinking-32k` and seed-audit runners already log, formalized.
`BudgetGuard` accumulates charged (falling back to estimated) cost and
raises `BudgetExceeded` at the cap; runners flush state and exit cleanly.

#### 3.5 `Preregistration` and `RunManifest`

- `Preregistration`: markdown file with YAML front matter parsed to a
  model — run kind, exact config hash, bank id + sha256, metrics, pass
  rule, spend cap, author, date. Committed under
  `labruns/<cycle>/<domain>/` *before* the run.
- `RunManifest`: written by every runner on completion — run id, prereg
  path (where applicable), config hash, bank hashes, provenance blob,
  headline numbers, ledger totals, artifact paths. Committed.

#### 3.6 Storage layout (`store.py`)

```
labdata/                                  # gitignored; FUSIONKIT_LAB_ROOT
  banks/<domain>/<bucket>/<bank_id>.jsonl
  samples/<cycle>/<domain>/<signature>.jsonl
  runs/<cycle>/<domain>/<run_id>/         # raw outputs, logs, judge transcripts
labruns/                                  # committed
  <cycle>/<domain>/
    prereg-<run_id>.md
    manifest-<run_id>.json
    report-<run_id>.md
```

### Definition of done

- Round-trip unit tests for every schema; JSONL streaming read/write for
  banks that don't fit in memory.
- A migration script converts one existing `analysis/` candidate-bank JSON
  into a `SampleBank` (proves the schema covers historical data).
- Confirm-manifest loader refuses to read Confirm task *content* unless
  called with an explicit `unseal=True` flag that only the Stage-6 runner
  sets (a code-level tripwire, not real security — the real control is the
  external storage ACL).

---

## 4. Stage 2 — Grader framework + reference grader + audit tooling

**Goal:** one grader interface all four domains implement; the algorithmic
grader ported onto it (proving the interface against working code); the
grader-audit workflow from process doc §1d as a CLI. **This stage freezes
the interface Track B builds against.**

### Deliverables (`fusionkit_evals/graders/`)

```python
class GraderSpec(BaseModel):          # discriminated union on `type`
    type: Literal["stdin_stdout", "docker_patch_test", "mutation_kill", "sql_result_set"]
    ...                               # per-type fields

class GradeResult(BaseModel):
    passed: bool
    score: float | None               # e.g. mutation kill rate; None for binary domains
    detail: dict                      # tests run, failures, timings
    grader_version: str               # bump ⇒ prior verdicts stale

class Grader(Protocol):
    spec_type: ClassVar[str]
    def grade(self, task: TaskRecord, answer: str, *, workdir: Path) -> GradeResult: ...
```

- Registry: `build_grader(spec) -> Grader`, with an exhaustive match over
  `GraderSpec.type` (never-check on the default arm per repo rules).
- **`StdinStdoutGrader`**: wraps the existing `verify_solution` +
  `LocalSandbox`/`DockerSandbox` + `checkers` path. Behavior-identical to
  today's algorithmic grading — verified by running both paths over an
  existing committed bank and diffing verdicts.
- Stubs (`NotImplementedError` with the Track B stage number) for the
  other three types, so `GraderSpec` is complete from day one.

### Grader audit tooling (`fklab grader-audit`)

- `fklab grader-audit sample --domain X --bank Y -n 50` → draws a stratified
  random sample (passes and fails), emits an audit sheet (JSONL + rendered
  markdown: task, answer, verdict, grader detail).
- Human fills in agree/disagree; `fklab grader-audit score <sheet>` computes
  verdict accuracy, writes an `AuditRecord` (committed) with the ≥95% gate.
- `store.py` refuses to mark a bank "counted" (usable by Stages 3–6 in
  earnest) until a passing `AuditRecord` exists for its domain+grader
  version. Override flag exists for smoke runs and is recorded in manifests.

### Definition of done

- Verdict-diff test: `StdinStdoutGrader` reproduces the pass/fail flags of
  an existing committed candidate bank exactly.
- Unit tests for the audit sampler (stratification, determinism given a
  seed) and the gate.
- Track B interface is declared frozen (changes after this point require a
  spec addendum).

---

## 5. Stage 3 — Screen sweep runner (process Step 2)

**Goal:** `fklab sweep` generalizes the pattern that today lives in
`analysis/thinking-32k/scripts/c3_thinking32k_runner.py` and the
seed-audit runner: every shortlisted model × every Screen task, single
sample, incremental persistence, budget guard, truncation audit — as a
reusable command instead of a copy-pasted script.

### Deliverables

- `fklab sweep --cycle 2026-q3 --domain algorithmic --bank <screen-bank-id>
  --models r1,terminus,qwen3t --max-spend 50 [--completion-tokens 32768]`
- **Provider client** (`fusionkit_lab/providers.py`): async, wraps the
  existing `FusionEngine.producer.generate_panel` path, plus the known-debt
  fix — mid-stream/malformed-response failures are caught per call,
  retried up to N times with backoff, and logged as `status="failed"`
  ledger rows, never silently dropped. (This is the "10 malformed
  responses out of 60 tasks" bug from the seed audit.)
- Per-row outcomes appended to the `SampleBank` as they complete (resume =
  skip rows already present, keyed on `(task_id, endpoint_id, sample_index)`).
- **Truncation audit** (`fklab audit truncation <bank>`): per model —
  truncated-row %, the >10% refusal flag, escalation recommendation
  (32k → 64k rung from the registry).
- **Qualification report** (`fklab report screen`): per model — pass rate
  with Wilson CI (existing `bench_stats.wilson_interval`), cost/task,
  latency percentiles, truncation %, verdict
  (`qualified | escalate | excluded`) + reason. Written to
  `labruns/…/report-<run_id>.md` and a machine-readable pool file that
  Stage 4 consumes.

### Definition of done

- Full sweep against the fake provider in CI: resume-after-kill test
  (kill mid-run, restart, byte-identical final bank), budget-abort test,
  retry-then-fail ledger accounting test.
- **Billed smoke (manual):** 3 models × 10 algorithmic Screen tasks,
  `--max-spend 5`, produces a qualification report; numbers sanity-checked
  against the historical seed-audit results for overlapping models.

---

## 6. Stage 4 — Candidate bank filler (process Step 3)

**Goal:** `fklab fill` runs the qualified pool over the Select bank with
K samples per model per task — the cycle's main API spend — safely.

### Deliverables

- `fklab fill --cycle … --domain … --bank <select-bank-id> --pool <pool-file>
  --k 3 --k-overrides cheap1=5,cheap2=5 --max-spend 800`
- Same runner core as Stage 3 (shared internally; sweep is fill with K=1
  on a Screen bank plus the qualification report), plus:
  - deterministic sample seeds recorded per row;
  - per-model concurrency limits (provider rate limits differ);
  - a `--dry-run` cost estimator: task count × pool × K × price table →
    projected spend, printed before anything runs and recorded in the prereg.
- Grading inline as samples arrive (the grader is domain-pluggable via
  Stage 2), so a completed fill *is* the candidate bank.
- **Bank health report** (`fklab report bank`): per model pass@1 and
  pass@K (existing `bench_stats.pass_at_k`), variance across samples,
  truncation/failure rates, per-task `n_pass` distribution, decision-task
  count (`0 < n_pass < total` — the rows a judge can actually affect),
  oracle ceiling and headroom over the pool (reusing the
  `diagnose_bank` logic via the Stage-1 adapter).

### Definition of done

- CI: K-sample fill against the fake provider; adapter round-trip into
  `CandidateBank`; pass@k math cross-checked against `bench_stats` directly.
- **Billed smoke (manual):** qualified pool × 20 Select tasks × K=3 on
  algorithmic, `--max-spend 40`; health report shows nonzero headroom
  (or the run is repeated with a different pool — a zero-headroom smoke
  proves nothing about the machinery).
- **M1 review:** at this point the `analysis/` scripts are formally
  superseded; a short doc maps each old script to its `fklab` equivalent.

---

## 7. Stage 5 — Offline ensemble search (process Step 4)

**Goal:** `fklab search` explores panels × topologies × judges against the
frozen `SampleBank` with no new panel calls (judge calls only), against
the non-negotiable baselines, with the train/validation discipline built
in — generalizing the Phase-0 judged-replay prototype and the
`fusion_hillclimb` Tier-1 machinery.

### Deliverables

#### 7.1 Search space definition (committed YAML per run)

```yaml
panels:      { min_size: 2, max_size: 4, pool: <pool-file>, lineage_veto: true }
topologies:  [parallel_judge, parallel_synth, cascade, exec_select]
judges:      { models: [j1], prompts: [p1.md, p2.md] }
finalist_cap: 2
split:       { train: 0.7, seed: 47 }
```

#### 7.2 Replay engine (`fusionkit_lab/replay.py`)

- **Topology implementations**, each a pure function
  `(bank_slice, topology_config, judge_client) -> per-task verdicts`:
  - `parallel_judge` / `parallel_synth`: anonymize + order-randomize
    candidates (seeded), call the judge, grade the merged answer with the
    domain grader. Judge hygiene (no model names, no reference answer) is
    enforced by the prompt builder type — it never receives model ids.
  - `cascade`: cheap model's sample first; escalate to the panel on
    configurable signals (its own sample failed public tests where the
    domain has them — reusing `exec_select` — or self-reported
    uncertainty). Cost accounted as cheap-only on non-escalated rows.
  - `exec_select`: the existing execution-guided selection, generalized
    over the bank (no judge calls at all where public tests exist).
- Judge calls are cached content-addressed
  (`sha256(judge_model + prompt + candidate set)`) so repeated
  configurations replay free; the cache is also a spend saver across runs.

#### 7.3 Baselines (computed for every comparison, from the bank, $0)

1. Every panel member alone (pass@1 per model).
2. **Best single model × K at matched cost** — best-of-N over that model's
   K samples, N chosen so total cost matches the ensemble's measured cost.
3. Frontier anchor — a config-file constant per domain (measured or
   published score + price), clearly labeled as external context.

#### 7.4 Selection discipline (enforced, not advisory)

- The bank is split train/validation once per search run (seeded, task-level,
  reusing `prompt_tuning.split_dev_val`); all config ranking happens on
  train; the top `finalist_cap` configs are re-scored on validation; a
  config whose validation uplift collapses (configurable threshold) is
  flagged and demoted.
- Comparisons use paired McNemar (`prompt_tuning.mcnemar`) vs best single
  member and vs best-of-N.
- Output: `FinalistRecord` (committed) — full frozen config (members with
  identity hashes, topology + parameters, judge model + prompt hash),
  train/val numbers, all baselines, and the machine-readable
  **route-don't-fuse verdict** when a single model wins.

#### 7.5 Outcome-matrix archive hook

Every evaluated config's per-task verdicts are appended to the archive
schema (Stage 7) — this is the router's future training data and costs
nothing to keep.

### Definition of done

- CI (fake judge): topology unit tests — anonymization is total (a judge
  prompt containing any model id fails the test), cascade cost accounting,
  exec_select equivalence with the existing module, split determinism,
  finalist-cap enforcement, McNemar wiring.
- **Billed smoke (manual):** search over the Stage-4 smoke bank with one
  real judge model, `--max-spend 20`; verify the judge cache halves the
  cost of an immediate re-run.

---

## 8. Stage 6 — Confirm runner (process Step 5)

**Goal:** `fklab confirm` executes exactly one preregistered, frozen,
end-to-end run per finalist on the sealed Confirm bank, and refuses to do
anything else.

### Deliverables

- `fklab confirm prereg --finalist <record> --bank <confirm-manifest>` →
  generates the preregistration from the `FinalistRecord` (config hash,
  bank sha256, metrics, the pass rule: fused ≥ best member AND fused beats
  frontier anchor on $/solve), which is then committed by a human.
- `fklab confirm run --prereg <path> --max-spend 300`:
  1. Verifies the prereg is committed on the current git HEAD (dirty-tree
     refusal) and that the finalist config hash matches.
  2. Fetches the Confirm bank from its external URI, checks sha256 against
     the committed manifest, loads with `unseal=True`.
  3. Runs the frozen topology **fresh, end-to-end** — panel calls, judge
     calls, grading — no `SampleBank` reuse. Same provider client, ledger,
     budget guard, resume-on-crash as Stage 3/4 (resume within one run is
     allowed; a *second run* of the same prereg is not).
  4. Computes: fused pass rate + Wilson CI, per-member and best-of-N
     comparisons on the same rows, McNemar vs best member, $/solve vs the
     frontier anchor, truncation audit (>10% ⇒ the run is **refused** —
     recorded, not published).
  5. Writes the `RunManifest` with a `pass | fail | refused` verdict
     against the preregistered rule.
- **Attempt cap enforcement:** the store counts committed Confirm manifests
  per domain per cycle; the third attempt in a cycle is refused by the CLI
  (process rule: 2 per domain per cycle; failures return to Step 4).
- Spent Confirm banks are marked `spent` in their manifest; a spent bank
  can be re-tagged as next cycle's Select material but never re-used for
  Confirm.

### Definition of done

- CI (fake providers): prereg-hash mismatch refusal, dirty-tree refusal,
  sha256 mismatch refusal, attempt-cap refusal, truncation-refusal path,
  pass-rule evaluation truth table.
- **Billed smoke (manual):** a "rehearsal confirm" on a *non-sealed*
  holdout slice of Select data (explicitly labeled `rehearsal` in the
  manifest), end-to-end with real APIs — proving the pipeline before the
  first real sealed run. **M2** = this rehearsal passing on algorithmic.

---

## 9. Stage 7 — Packaging and archive (process Step 6)

**Goal:** turn a passing Confirm run into the three shipping artifacts —
frozen product config, evidence card, archived outcome data — mechanically.

### Deliverables

- `fklab package --run <confirm-manifest>`:
  - **Frozen ensemble config**: emits the `.fusionkit/` fusion config for
    the named model id (e.g. `fusionkit/repo-bugfix`) from the finalist
    record — panel endpoints, judge, prompts, token budgets — plus the
    config hash. This is the handoff to the product serve path.
  - **Evidence card**: markdown from a template — what it is, benchmark
    name and date, fused score + CI, vs best member, vs best-of-N, vs
    frontier anchor, $/solve, links to the committed manifest and prereg,
    **expiry date = issue date + one model generation (~4 months)**.
  - Card index: `docs/fusion/cards/index.json` with issue/expiry dates so
    expired cards are mechanically listable (`fklab cards status`).
- `fklab kill-ledger add --run <manifest>`: appends failed gates ("don't
  fuse domain X panel Y; route to Z") with run links — the publishable
  negative-results ledger.
- **Router archive** (`fusionkit_lab/archive.py`): one parquet/JSONL
  schema unifying Stages 3–6 outcomes:
  `(cycle, domain, task_id, task_metadata, config_id, config_kind
  [single|ensemble|baseline], verdict, cost, tokens)` — append-only under
  `labdata/archive/`, with a committed row-count + sha256 manifest per
  cycle.

### Definition of done

- CI: card rendering golden test; expiry math; archive schema round-trip;
  emitted `.fusionkit/` config validates against the product loader
  (`fusionkit init`, install the emitted v4 JSON at
  `.fusionkit/fusion.json`, then run `fusionkit doctor`).
- The M2 rehearsal run from Stage 6 produces a card + archive slice
  reviewed end-to-end.

---

## 10. Track B — Domain graders and harvesters

Interface contract for all of Track B: implement `Grader` for one
`GraderSpec` variant + a harvester producing `TaskRecord`s; everything
upstream (sweep/fill/search/confirm) works unchanged.

### Stage 8 — Repo-bugfix grader (`docker_patch_test`) — **launch bottleneck**

**Goal:** per-instance patch-and-test grading for SWE-bench-Pro-style
tasks, runnable locally with Docker.

**Spec fields:** `image` (e.g. the task's `dockerhub_tag`), `reset_cmd`
(`before_repo_set_cmd`), `fail_to_pass` / `pass_to_pass` test lists,
`test_cmd` template, `timeout_s`.

**Grade path:**
1. Start the task container (network off), run `reset_cmd`.
2. Apply the model's answer as a unified diff (`git apply` with fallback
   to fuzzy patch); malformed patch ⇒ `passed=False`,
   `detail.reason="patch_apply_failed"` (a *grade*, not an error).
3. Run `fail_to_pass` (all must now pass) then `pass_to_pass` (spot-check
   sample, configurable) with per-suite timeouts.
4. `GradeResult.detail` carries per-test outcomes and durations.

**Engineering notes:** container pool with concurrency limit (these are
minutes-long grades — the fill runner's inline grading must run graders in
a worker pool, sized separately from API concurrency; this is why
`Grader.grade` is sync and the runner owns the thread pool). Image
prefetch command (`fklab grader prefetch --bank …`) so a fill isn't
network-bound mid-run.

**Definition of done:** grades the SWE-bench Pro public dev slice using
gold patches (expect ~100% pass) and reversed/empty patches (expect 0%) —
the standard harness self-test; grader audit (§4) run on 50 verdicts;
a 10-task billed smoke through `fklab fill` with 2 models.

### Stage 9 — Test-generation grader (`mutation_kill`)

**Spec fields:** module source ref, correct-code image/venv spec, mutant
generator config (`mutmut` operators, cap per task), `min_kill_rate`.

**Grade path:** (1) generated tests must pass on the correct code (gate);
(2) run the capped mutant set, `score = kills / mutants`,
`passed = score ≥ min_kill_rate`. Mutants are generated **once at harvest
time** and stored in the task record (deterministic grading, no
mutation-tool nondeterminism at grade time).

**Definition of done:** golden tests on a toy module (a known-good suite
kills the planted mutants; a vacuous suite scores ~0); audit; 10-task
billed smoke.

### Stage 10 — SQL grader (`sql_result_set`)

**Spec fields:** dialect (start: SQLite + DuckDB), schema DDL, seed data
ref, expected result (stored as the *original query's output* computed at
harvest time), comparison mode (set / multiset / ordered, float
tolerance), `timeout_s`.

**Grade path:** create ephemeral DB, load seed, run the model's query
read-only, compare result sets. Malformed SQL ⇒ fail with reason.

**Definition of done:** golden comparator tests (column order, row order,
NULLs, float tolerance); audit; 10-task billed smoke.

### Stage 11 — Task harvesters (`fusionkit_lab/harvest/`)

One CLI per recipe, all emitting `TaskRecord` JSONL + a bank manifest:

- `fklab harvest repo-bugfix --repos <list> --since 2026-01`: the
  "rewind the fix" recipe — crawl merged PRs referencing an issue and
  touching tests; check out commit N; **verify test T fails at N and
  passes at N+1** inside the task container (flaky filter); package
  snapshot + issue text + grader spec. `created_at` = merge date.
- `fklab harvest test-gen --repos <list>`: find modules with healthy
  suites; strip tests; pre-generate + store mutants; record the original
  suite's kill rate as the reference score.
- `fklab harvest sql --sources <dbt/analytics repos>`: extract query +
  schema; generate the NL description (LLM-drafted, human-approved queue —
  the one place a human is in the harvest loop); compute + store expected
  results.
- `fklab harvest algorithmic --window 2026-03:2026-07`: wraps the existing
  `livecodebench_data.py` rolling-window loader into the `TaskRecord`
  schema.
- Shared: dedupe by content hash, license/provenance field per source
  repo, bucket assignment rule (`created_at` after the newest model cutoff
  ⇒ eligible for Confirm), and a `--target-counts screen=50,select=160,confirm=250`
  planner that reports shortfalls.

**Definition of done:** each harvester run on 2 real public repos
produces ≥20 valid tasks whose graders pass the gold-answer self-test;
harvest provenance appears in bank manifests.

---

## 11. Test and validation strategy (cross-stage)

| Layer | What | When |
|---|---|---|
| Unit (CI, $0) | schemas, store, guards, refusal paths, topology math, comparators | every PR |
| Replay (CI, $0) | search + report stages over committed fixture banks (small, synthetic) | every PR |
| Grader self-tests ($0) | gold answer ⇒ pass, corrupted answer ⇒ fail, per domain | every PR touching a grader |
| Billed smoke (manual, capped) | each runner stage, ≤$50 each, real providers | at each stage's DoD; before M1/M2/M3 |
| Grader audit (human) | 50-verdict audit per domain per cycle | before a bank "counts" |
| Rehearsal confirm | full pipeline on non-sealed holdout | before the first real Confirm |

CI additions: `python/fusionkit-lab` joins the root pyright include list
and the pytest `testpaths`; no new CI jobs needed (uv workspace already
covers it).

---

## 12. Suggested implementation order and parallelism

Strict order: 0 → 1 → 2. After Stage 2, two engineers (or two work
streams) can proceed independently:

- **Stream 1 (engine):** 3 → 4 → 5 → 6 → 7, validating everything on the
  algorithmic domain (grader already exists after Stage 2).
- **Stream 2 (domains):** 8 (start immediately — it gates launch), then
  9 and 10 (small), with 11 interleaved per domain as its grader lands.

First full cycle on real domains (M3) requires: Stream 1 complete + Stage
8 + the repo-bugfix harvester slice of Stage 11. Test-gen and SQL join the
portfolio as Stages 9/10/11 complete — the engine doesn't change.

---

## 13. Open items to resolve during implementation (not blockers to start)

1. **CLI library** — stdlib `argparse` (repo precedent) vs `click`;
   decide at Stage 0, trivial either way.
2. **Confirm bank storage** — private git repo vs object storage; needs
   the manifest-URI scheme fixed at Stage 1, the backend can be swapped.
3. **Judge model policy** (one family across domains, per the process
   doc's open decision #3) — a search-space config choice, not a code
   change.
4. **Parquet vs JSONL for the router archive** — decide at Stage 7 based
   on volume from the first cycle; the schema is the commitment, not the
   container.
5. **Role-based topology** — deliberately deferred out of Stage 5's
   `topologies` list until a domain with trajectory-shaped answers
   (terminal/agentic, cycle 2) needs it; the topology interface must not
   preclude it.
