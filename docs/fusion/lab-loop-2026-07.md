# The Lab Loop — how we find, prove, and package our launch ensembles (2026-07)

**Status:** working plan, adopted 2026-07-06 after founder brainstorm.
**Reader:** a new team member with no prior context. Everything is explained
from zero; no earlier document is required reading. Where a term has a
precise meaning, it is defined the first time it appears.
**What this document covers:** the repeatable process (the "lab loop") that
produces our first launch products — several named ensembles, each sold as a
single model — and the data that will later power a router that picks
between them.

---

## Part I — The high-level overview (read this first)

### What the company sells

Open-source AI models have become nearly as good as the expensive frontier
models (GPT-5.5-class, Claude Opus-class) at coding, while costing 30–150
times less per token. We combine several cheap open-source models so that
their **combined** answer matches or beats the expensive model, and we sell
that combined answer as if it were one model. The user sends one request and
gets one answer; the fanout to multiple models and the merging happen behind
the scenes.

### What we are launching first

A **portfolio of a few named ensembles**, each specialized for one kind of
coding work (for example: fixing bugs in a repository, generating test
suites, writing tricky standalone functions). Each ensemble:

- looks like a single model to the user (one API model id, e.g.
  `fusionkit/repo-bugfix`);
- has a **frozen recipe**: which models are on the panel, how their answers
  are merged, which model acts as judge;
- ships with an **evidence card**: a dated, public one-pager stating its
  measured score and cost on a named benchmark, versus the best single model
  and versus a frontier model, with links to raw artifacts.

A second product — a **router** that reads the user's task and automatically
picks the right ensemble — comes later. We are not designing it now, but the
lab loop deliberately produces the data it will need (which kind of task each
ensemble wins on), so building it later is cheap.

### Why we need a "lab loop" at all

Because nobody else can tell us which models to combine:

- **Public leaderboards can't.** We tested this formally (three times): using
  public benchmark data to pick model combinations never beat the naive
  approach of "take the top-K models by average score" on held-out data.
  Public data is useful for *shortlisting* candidates and *task-shape mining*
  — never for the final pick.
- **Public benchmarks are also broken.** The industry-standard coding
  benchmark (SWE-bench Verified) was deprecated by OpenAI in February 2026:
  most of its hard tasks had flawed test suites, and frontier models had
  memorized its answers. Trustworthy measurement has moved to private,
  held-out task sets.
- **Models change every ~3–4 months.** Any specific model ranking goes stale
  within one generation. What must be durable is the *process* that
  re-measures, not any single result.

So the lab loop is our own measurement machine: it takes the current
generation of open-source models, measures them on our own task banks with
graders we trust, searches for the best combinations, and confirms the
winners on tasks nothing was tuned on. Every claim we publish comes out of
this loop, and the whole loop re-runs each time a new model generation
appears.

### The loop in one diagram

```
STEP 0  Choose the launch domains (the portfolio)            $0, judgment + cheap data
STEP 1  Build task banks + graders per domain                engineering time
STEP 2  Qualify individual models (screen sweep)             ~$50–150
STEP 3  Run qualified models on the Select bank,             ~$300–800 total
        several samples each → the CANDIDATE BANK
STEP 4  Search ensembles OFFLINE against the bank            ~$50–200 (judge calls)
        (panels × shapes × judges vs honest baselines)
STEP 5  Confirm each finalist ONCE on a sealed               ~$100–300 per domain
        holdout → the launch number
STEP 6  Package: named model id + frozen config +            $0
        dated evidence card; archive data for the router
```

Total API cost for a 3–4 domain launch cycle: roughly **$1–3k**. Money is
not the bottleneck. The bottlenecks are (a) building graders we trust and
(b) the discipline not to contaminate our own holdout sets.

### The three ideas that make the loop work

1. **Generate once, search many times.** The expensive step is calling the
   panel models. So each qualified model answers each task once (actually a
   few times — see "samples" below), and everything is saved. After that,
   testing "panel A vs panel B vs panel C, merged this way or that way" is a
   cheap *replay* of saved answers — only the judge needs new API calls.
   Searching 200 ensemble configurations costs about the same as searching 5.
2. **Three task buckets with different rules.** Tasks are split into
   Screen (cheap filtering), Select (where all the searching happens), and
   Confirm (sealed until the final run). This is how we avoid fooling
   ourselves: the number we publish comes from tasks that no part of the
   search process ever touched.
3. **Honest baselines built in.** Every comparison includes "the best single
   model, sampled K times, at the same total cost" — because research shows
   that sometimes beats multi-model panels. If a single model wins, the
   shipped verdict is "route to that model," and that is a perfectly good
   menu item. We are selling measured truth, not the fusion story.

---

## Part II — The concepts (glossary)

- **Panel.** A set of 2–4 models that all attempt the same task.
- **Ensemble.** A panel plus the machinery that merges its answers into one.
- **Judge / synthesizer.** The model that reads all candidate answers and
  either picks the best one or writes a new answer combining the best parts.
- **Fusion / synthesis.** The merging step performed by the judge.
- **Topology.** The *shape* of an ensemble. The three we test:
  - *Parallel:* all panel members answer independently; the judge merges.
  - *Cascade:* one cheap model answers first; the panel is only called if
    the first answer looks unreliable. Much cheaper on easy tasks.
  - *Role-based:* different models play different roles in a multi-step
    task (one plans, one writes code, one reviews). For task types where
    answers are trajectories rather than single artifacts.
- **Best-of-N (the honesty baseline).** One strong model sampled N times,
  best answer kept, at the same total cost as the panel. Every pilot must
  beat this, or the multi-model premise fails for that domain.
- **Oracle.** The panel's theoretical ceiling: the score if a perfect
  referee always picked a passing candidate whenever any member produced
  one. Nobody achieves the oracle; it measures *potential*.
- **Headroom.** Oracle minus the best single member's score. Headroom exists
  only when members fail on *different* tasks. No headroom → no reason to
  fuse.
- **Capture rate.** The fraction of headroom our real fusion realizes. If
  headroom is +12 points and the fused answer scores +6 over the best
  member, capture is 50%. This is the company's core quality number.
- **Grader.** The mechanical procedure that decides pass/fail for one task
  (run the tests, compare query results, type-check, etc.). A grader we
  can't trust poisons everything downstream.
- **Candidate bank.** The stored table of every model's answers to every
  Select task, with pass/fail flags. The raw material for offline search.
- **Truncation.** When a model hits its output-token limit before finishing.
  A truncated answer is not a measurement of ability. Standing rule: any
  model with more than ~10% truncated rows gets its number refused, and we
  either raise the token budget or exclude the model.
- **Contamination.** When a model has seen a benchmark's tasks (or answers)
  in its training data, so its score measures memory, not ability. The
  defense: use tasks created *after* the model's training cutoff.
- **Preregistration.** Writing down what will be run and what counts as
  success *before* running it. Prevents quietly moving the goalposts.

---

## Part III — The steps, in full detail

### Step 0 — Choose the launch portfolio (domains)

A **domain** is a category of coding work that becomes one named product.
Candidates are scored against five filters:

| Filter | Question |
|---|---|
| **Demand** | Do developers actually pay for this today? |
| **Gradeable** | Can we score pass/fail mechanically, with a grader we trust? |
| **Peer field** | Are several OSS models close in ability (vs one dominating)? |
| **Headroom** | Do models fail on *different* tasks, leaving room for fusion? |
| **Ship timeline** | Can the bank + grader be ready this cycle? |

Notes on the filters:

- Demand and grader readiness matter most for the *first* launch, because we
  cannot ship what we cannot measure.
- A lopsided field (one model crushes everyone) is not a dead domain — it
  ships as a *routing* verdict ("use model X alone"), which is an honest and
  useful menu item. But it can't be a fusion showcase.
- The portfolio should span *different task shapes* so the menu feels
  complete rather than four variants of one thing.

**Current working portfolio (3–4 slots):**

| Slot | Domain | Rationale | Grading status |
|---|---|---|---|
| Flagship | **Repo bugfix** — fix a failing issue/test in a real repository | Highest demand; the moment every developer knows ("my build is red") | Patch-and-test harness in progress (the main engineering item) |
| Differentiator | **Test generation** — write a test suite for given code | High demand, universally disliked chore, low adoption risk (a bad generated test doesn't break prod); no public benchmark exists, so the measurement category is ours to define | Mutation-based grader to build (see Step 1); moderate effort |
| Fast win | **SQL / data queries** — write the query/pandas that answers X | Huge audience; deterministic grading (execute, compare result sets); cheap bank | SQL runner + comparator to build; small effort |
| Testbed / reframed product | **Hard function implementation** (algorithmic) — write a tricky standalone function correctly | Weak as a standalone purchase, but our best-instrumented domain: harness works today, so all fusion/judge/topology R&D iterates here fastest and cheapest. Ships reframed in user language, possibly as a routing verdict | Works today |
| (deferred) | Terminal/agentic, performance optimization, security patching, build/CI repair | Real products, heavier harnesses; cycle 2 | — |

Also considered and parked: type-annotation migration (very gradeable, cheap,
boring-in-a-good-way — a strong cycle-2 candidate), code translation/porting,
bounded refactors. Rejected for v1: frontend UI (no trustworthy mechanical
grader), free-form code review (subjective; revisit later as defect-*detection*
with seeded bugs), greenfield feature building (no ground truth exists).

### Step 1 — Build the task banks and graders

This is usually the real schedule bottleneck — start all domains in
parallel.

#### 1a. The three buckets

Every domain gets three disjoint task sets with different jobs and rules:

| Bucket | Size | Job | Rules |
|---|---|---|---|
| **Screen** | ~40–60 tasks | Filter models cheaply: is the model measurable (truncation), roughly how good, at what cost/latency? | Reuse freely; noise tolerable |
| **Select** | ~120–200 tasks | Home of the candidate bank; all ensemble searching happens here | Search freely, but *selection decisions* use a train/validation split inside the bucket |
| **Confirm** | ~150–300 tasks | Produce the launch number | **Sealed.** Never looked at during search. One preregistered run per finalist per cycle |

Why the sizes: with ~60 tasks a measured pass rate has a confidence interval
of roughly ±12 percentage points — fine for screening, embarrassing for a
public claim. At 200–300 tasks the interval tightens to roughly ±5–6 points,
enough for "fused beats best member" to clear zero.

#### 1b. Where tasks come from: mine, then build

**We never write exam questions by hand.** Every task is harvested from a
place where a real developer already solved a real problem and a mechanical
success check already exists. The general recipe:

```
real repo history:  commit N   = bug exists, test T fails
                    commit N+1 = human fixed it, test T passes
        ↓
TASK    = repo at commit N + the issue text
GRADER  = does test T pass after the model's patch?
```

The repo wrote the question, the difficulty, and the grader. We package it.

Per-domain recipes:

- **Repo bugfix — "rewind the fix."** Crawl merged PRs that reference an
  issue, touch code, and add/fix a test. Check out the commit before the
  fix; verify the test fails there and passes after (this automatically
  filters flaky garbage). Task = repo snapshot + issue text; grader = the
  fix's tests. This is exactly how SWE-bench was constructed — the method is
  public; what makes ours different is running it on *recent* commits (see
  1c) and on repos we choose.
- **Test generation — "break it and see who notices."** Take a real module
  with a decent test suite (proof it's testable). Delete the tests. Task =
  "write tests for this module." Grader, two checks: (1) generated tests
  must pass on the correct code; (2) apply *mutants* — small automatic
  corruptions (flip a `<` to `<=`, delete a branch, change a constant;
  tools like `mutmut` / `cosmic-ray` generate these) — and count how many
  the generated tests catch. The kill rate is a quantitative quality score.
- **SQL / data — "re-derive the query."** Take real schemas + real queries
  (analytics repos, dbt projects). Write or generate-and-human-check a
  natural-language description of what the query returns; delete the query.
  Grader = run the model's query against seeded data, compare result sets
  with the original's output.
- **Hard function implementation.** Mine LiveCodeBench-style tasks from
  rolling windows (tasks published after model training cutoffs); the
  existing harness already grades stdin/stdout behavior against tests.

#### 1c. The mine-vs-build split per bucket

| Bucket | Source strategy |
|---|---|
| Screen | Mostly **mined/adapted** from public sets — fast, volume matters, mild noise OK |
| Select | **Mixed** — public task *shapes* cleaned and re-graded in our harness, plus harvested real tasks |
| Confirm | **Mostly built** — harvested from commits *newer than every model's training cutoff* (last ~6 months), from licensed or partner repos. Contamination becomes impossible by construction: the answers didn't exist when the models were trained |

Public sources are mined for **structure and metadata, never for trust in
their numbers**. Concretely, the useful public material we have verified
field-by-field:

- **SWE-bench Verified (HuggingFace, 500 tasks).** Task definitions only:
  `instance_id`, `repo`, `base_commit`, `problem_statement`, `FAIL_TO_PASS` /
  `PASS_TO_PASS` test lists, `difficulty`, gold `patch` (never shown to
  models). Good Screen/Select shape material; not usable for public claims
  (deprecated, contaminated).
- **SWE-bench Pro (HuggingFace, 731 public tasks).** Richer: adds
  `requirements`, `interface`, `repo_language`, `issue_categories`,
  `issue_specificity`, `before_repo_set_cmd`, `selected_test_files_to_run`,
  and a `dockerhub_tag` per instance for containerized grading. The best
  public Select material for repo bugfix; its held-out and commercial splits
  (graded by Scale on submission) are a usable external Confirm complement.
- **LLMRouterBench SWE subset (HuggingFace bundle).** Per-model, per-task
  outcomes for ~15 models × 500 SWE tasks under one framework: each record
  has `instance_id`, full `prompt`, the model's `prediction` (patch),
  `raw_output`, binary `score`, `prompt_tokens` / `completion_tokens`,
  `cost`. This is the cleanest public *model-level* prior for repo bugfix —
  used for shortlisting and lineage vetoes, never for final panel picks
  (settled result), and its model snapshot (late 2025) is already stale.
- **SWE-bench experiments (GitHub).** Per-submission `metadata.yaml` (system
  name, models used, org, attempts) + `results.json` (list of resolved
  instance ids) for 235+ agent submissions. System-level (agent + scaffold +
  model entangled) — useful for field-shape context, not model truth.
- **Terminal-Bench trajectories, LiveCodeBench, LiveBench, BigCodeBench.**
  Analogous roles for the terminal and algorithmic domains.

For test generation and SQL there is no usable public outcome matrix — those
banks are built entirely by harvesting (which is a feature: the measurement
category is empty, and we get to define it).

#### 1d. Grader audits (as important as the tasks)

The industry lesson from the SWE-bench Verified collapse: grading
infrastructure itself is often wrong (independent audits found roughly a
third of verdicts incorrect on some benchmarks). Standing rule, same spirit
as the truncation rule:

> Before a domain's numbers count, a human audits ~50 random grader verdicts
> (both passes and fails). If verdict accuracy is below ~95%, fix the grader
> before scaling the bank. Re-audit a sample every cycle.

#### 1e. One task, one JSON object

Every task, in every domain, in every bucket, is one record with the same
skeleton (the internal schema; field names indicative):

```json
{
  "task_id": "repo_bugfix:nodebb-0499-vnan",
  "domain": "repo_bugfix",
  "bucket": "select",
  "source": "harvested:github/NodeBB@2026-05",
  "created_at": "2026-05-14",
  "prompt": "<issue text + code context; never the gold answer>",
  "grader": {
    "type": "docker_patch_test",
    "image": "…",
    "reset_cmd": "…",
    "fail_to_pass": ["test/database.js::…"],
    "pass_to_pass": ["…"]
  },
  "metadata": { "language": "js", "difficulty_class": "…", "categories": ["…"] }
}
```

The `created_at` field is load-bearing: it is how Confirm sets prove
contamination-impossibility, and how expired tasks get rotated (a spent
Confirm set can be demoted to next cycle's Select once used).

### Step 2 — Qualify the individual models (screen sweep)

**Input:** a shortlist of 10–15 current OSS models from the provider catalog,
picked by vendor aggregates, price band, context length, provider stability,
plus 1–2 previous-generation "bridge" models to link data across cycles.

Two standing shortlist rules:

- **Pin the full identity.** A "model" is *model + provider + endpoint
  config*, pinned exactly. The same weights hosted by different providers
  behave differently (quantization, serving stack, token limits).
- **Lineage veto.** No two panel members sharing a base model or teacher
  (many OSS models are distilled from the same frontier teachers and fail on
  the same tasks while looking "diverse" by name). Shared-lineage pairs are
  vetoed unless their measured failure correlation is demonstrably low.

**Run:** every shortlisted model on every domain's Screen set, single-shot,
with a 32k-token completion budget by default and a 64k escalation rung for
"thinking" models (reasoning models routinely need ≥32k or their outputs
truncate — we have measured multiple models being unmeasurable at 32k).

**Output:** per domain, a **qualified pool** (typically 6–10 models) plus
cost/latency profiles. Models exit here for: truncation-invalidity at
practical budgets, instability (provider failures mid-stream), or clearly
inadequate ability.

**Cost:** ~$50–150 across all domains at once.

### Step 3 — Fill the candidate banks (the main API spend)

For each domain: every qualified model answers every **Select** task
**K times** (not once).

Why K samples per model per task:

1. It gives the **best-of-N baseline at matched cost for free** — the
   honesty check every ensemble must beat.
2. It measures run-to-run variance, so our confidence intervals are real.
3. It gives the judge richer material during offline search.

**Working default: K=3** for every model, **K=5 for the two cheapest
models** (to power stronger best-of-N baselines). This is the single
highest-value place to spend extra budget.

Everything is stored, content-addressed: the answer text, pass/fail from the
grader, tokens, latency, cost, truncation flag, provider errors. The result
is the **candidate bank**: a large matrix of

```
(model × provider) × task × sample → {answer, passed, cost, tokens, flags}
```

**Cost:** ~$300–800 total across 3–4 domains. The biggest line item; still
small money.

**Robustness note (known engineering debt):** provider mid-stream failures
must be handled and logged as retries, not silently dropped — one of our
audited models had 10 malformed-response failures out of 60 tasks on one
provider.

### Step 4 — Search ensembles offline (cheap, thorough)

Now the combinatorial search runs against the bank, with **no further calls
to panel models**. Only the judge makes new API calls (reading saved
candidates, writing merged answers).

**Search space, per domain:**

- **Panels:** all 2–4-member subsets of the qualified pool that survive the
  lineage veto.
- **Topologies:** parallel fusion; cascade (cheap model first, escalate on
  disagreement/uncertainty signals); role-based where the task shape allows.
- **Judges:** a small grid of judge prompts and 1–2 judge models. Judge
  hygiene is fixed and non-negotiable: candidates are anonymized and
  order-randomized; the judge never sees which model wrote what or any
  reference answer.

**Baselines in every comparison (non-negotiable):**

1. Every individual panel member alone.
2. **Best single model × K samples at matched total cost** (the Self-MoA
   baseline).
3. A frontier anchor (e.g. the strongest closed model's published/measured
   score) for context and the price claim.

**Selection discipline (this is where budget could fool us):** with cheap
replays we will run hundreds of comparisons, so overfitting our own Select
bank replaces public contamination as the main self-deception risk. Rules:

- Selection decisions are made on a **train split** inside Select and
  sanity-checked on the remaining **validation split**.
- The number of finalists is capped **before** the search: 1–2 per domain.
- "Route, don't fuse" (a single model wins) is a legitimate, shippable
  verdict and gets published like any other result.

**Output per domain:** 1–2 finalist configurations (members + topology +
judge, fully specified), plus the complete outcome matrix — which is
archived as the **router's future training data** (task metadata → which
ensemble/model won).

**Cost:** ~$50–200, essentially all judge calls.

### Step 5 — Confirmation (the launch number)

Per finalist:

1. **Freeze everything.** Members, providers, prompts, judge, token budgets,
   topology parameters — written down, hashed.
2. **Preregister.** A short document, written before the run: the exact
   config, the Confirm set, the metrics, and the pass rule.
3. **Run once, end-to-end, fresh** (no bank reuse) on the sealed Confirm
   set. Grade with the audited grader. Record per-row outcomes, tokens,
   costs, truncation flags, and the spend ledger.
4. The resulting numbers — pass rate with confidence intervals, cost per
   solved task, versus best member, versus best-of-N, versus the frontier
   anchor — go on the evidence card, stamped with the run date.

**Pass rule (the launch gate):** fused ≥ best single member *and* fused
beats the frontier anchor on cost-per-solve. Impressive pass: the
fused-vs-best-member confidence interval clears zero.

**Discipline rules:**

- If a finalist fails, we go back to Step 4 **on Select data** — we do not
  "try one variant" on Confirm. Confirm attempts are capped (2 per domain
  per cycle).
- Two failed finalists in a domain → that domain does not launch this
  cycle. That is the system working, not failing.
- Money can buy more tasks and more samples. It must never buy more peeks
  at Confirm.

**Cost:** ~$100–300 per domain.

### Step 6 — Package and archive

Per confirmed winner:

- A **named model id** (e.g. `fusionkit/repo-bugfix`) bound to the frozen
  config.
- A **dated evidence card** with an expiry: one model generation (~4 months)
  after issue. Expired cards are pulled from marketing until re-measured —
  model churn becomes a credibility feature ("freshness stamp") instead of
  an embarrassment.
- **Kill-ledger entries** for everything that failed a gate along the way
  ("don't fuse domain X panel Y; route to model Z"), published with links to
  the runs. Publishing negative results is cheap and nobody else does it.
- The **outcome matrices** from Steps 3–5 archived in one schema — this is
  the dataset the router trains on later, at near-zero additional cost.

---

## Part IV — Standing rules (apply to every step, every cycle)

1. **Preregister before running; spend ledger on every billed run.**
2. **Truncation audit on every measurement.** >~10% truncated rows → the
   number is refused, not caveated.
3. **Grader audit before the bank counts; re-audit every cycle.**
4. **Confirm is sealed.** One preregistered run per finalist; capped
   attempts; failures return to Select.
5. **Best-of-N baseline in every comparison.** If it wins, we ship the
   routing verdict.
6. **Judge hygiene:** anonymized, order-randomized candidates; no
   information leaking which model wrote which answer.
7. **Lineage veto** on panel composition; **pinned model+provider+config**
   identities everywhere.
8. **Everything model-specific is treated as perishable.** Panel configs,
   rankings, cards — all expire with the model generation. The durable
   assets are the harness, the banks, the discipline, and the archived
   outcome data.
9. **Rigor proportional to money at risk.** Screen decisions can be
   eyeballed; Select decisions need train/validation splits; Confirm gets
   the full apparatus.

---

## Part V — What exists today vs what must be built

| Piece | Status |
|---|---|
| Algorithmic harness (prompt + tests, sandboxed grading, candidate bank storage) | **Works today** (`python/fusionkit-evals`: `candidate_bank.py`, `livecodebench_data.py`, `sandbox.py`) |
| Offline judged-replay machinery | Prototype exists (the Phase-0 judged replay was exactly this); needs generalizing into the Step-4 search harness |
| Repo-bugfix patch-and-test grading | **In progress — the main engineering bottleneck** (HandoffKit patch path exists; per-instance checkout/grade loop must be wired into the eval harness) |
| Test-generation bank + mutation grader | To build (moderate; `mutmut`/`cosmic-ray` do the heavy lifting) |
| SQL runner + result-set comparator | To build (small) |
| Task harvesters ("rewind the fix", time-segmented Confirm sets) | To build (the harvester is reused every cycle thereafter) |
| Truncation-audited sweep runner | **Works today** (used in the seed-panel audit; generalize the runner pattern) |
| Preregistration / spend-ledger / round-immutability conventions | **In place** (see `analysis/` rounds) |
| Provider mid-stream failure robustness | Known debt; fix before the big Step-3 sweep |

## Part VI — Open decisions (need an owner and a date)

1. **Final portfolio composition** — recommended: repo bugfix + test
   generation + SQL + algorithmic-as-testbed; terminal deferred.
2. **K policy** — recommended: K=3 all models, K=5 the two cheapest.
3. **Judge policy** — recommended: one judge model family shared across
   domains, prompts tuned per domain; split judge models only if data
   demands it.
4. **Confirm sourcing** — start with licensed recent-history OSS repos;
   upgrade to design-partner repos as they sign. SWE-bench Pro held-out
   (submit-to-Scale) as an external complement for repo bugfix.
5. **Shortlist composition for the current generation** — from the live
   provider catalog at cycle start (last draft: DeepSeek V4 pro/flash,
   Qwen 3.7, GLM-5.2, Kimi K2.7-code, MiniMax M3, Nemotron 3, + one
   previous-gen bridge model).

---

## Appendix — Worked example of the money math (one cycle, 4 domains)

| Step | Assumption | Cost |
|---|---|---|
| Screen sweep | 12 models × 4 domains × 50 tasks × 1 sample | ~$100 |
| Candidate banks | ~8 qualified models × 4 domains × 160 tasks × K≈3 | ~$500 |
| Offline search | judge calls over ~150 configs × 4 domains | ~$150 |
| Confirmation | ≤2 finalists × 4 domains × ~250 tasks, end-to-end | ~$800 |
| **Total** | | **~$1.5k** |

Re-run every model generation (~3–4 months). The cards, rankings, and
panels produced are consumables; the banks, harnesses, harvesters, and
archived outcome matrices compound.
