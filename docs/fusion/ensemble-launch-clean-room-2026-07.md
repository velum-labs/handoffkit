# Ensemble Launch — Clean-Room Plan (2026-07)

> **Historical plan:** configuration and command examples below predate the
> RouteKit/Fusion v4 split. Current product config is
> `.fusionkit/fusion.json` v4 (namespaced RouteKit model IDs only) plus
> `.routekit/router.yaml` (models, providers, URLs, and key env names). The
> public `fusionkit serve` command does not accept a config-file flag.

**Status:** working plan, adopted 2026-07-07.
**Reader:** anyone assembling the first FusionKit ensemble configs. No prior
documents are required; everything needed to start is in this report.
**Scope:** the full path from zero to a shippable named ensemble — Phase A
(hypothesis formation, $0) through Phase D (launch-grade measurement and
packaging). Each phase has explicit inputs, outputs, cost, and definition of
done.
**Explicit stance:** this plan **starts from scratch**. Earlier internal
docs, model shortlists, aggregate scores, and panel recommendations are
**not inputs**. Only process discipline and publicly verifiable facts are
used. Prior internal experiments may exist elsewhere in the repository; they
are out of scope for this plan and must not contaminate model selection
here.

---

## Part I — What we are doing and why

### The product goal

FusionKit sells **named ensembles** — combinations of open-source coding
models that look like a single model to the user. The user sends one
request; several models attempt the task behind the scenes; a judge merges
their answers into one response.

Before we can run, measure, or launch any ensemble, we need **hypotheses**:
concrete panel configs (which models, how arranged, which judge) that we
*think* might work well enough to test. This report describes how to produce
those hypotheses honestly, cheaply, and without running our own benchmarks
yet.

### The four phases (overview)

| Phase | Question | Rigor | Typical cost |
|---|---|---|---|
| **A — Hypothesis formation** | What panels should we *try*? | Public data only; no runs | $0 |
| **B — Config materialization** | Do the configs actually run? | Engineering + smoke tests | ~$0–1 |
| **C — First measurement** | Which hypotheses survive on *our* harness? | Own calibration bank; no sealed holdout yet | ~$25–75 |
| **D — Launch measurement** | Which config can we *claim* and ship? | Task banks, sealed Confirm, evidence cards | ~$1–3k/cycle |

Phases A–C produce **internal** numbers only. Phase D produces **publishable**
evidence cards. Do not skip phases: each gates the next.

```
Phase A ($0)          Phase B (~$0)         Phase C (~$25–75)      Phase D (~$1–3k)
─────────────         ─────────────         ─────────────────      ──────────────────
catalog snapshot  →   fusion configs    →   candidate bank     →   task banks + graders
hypothesis cards  →   smoke tests       →   hypothesis verdict →   Confirm run
registry          →   prereg (lite)     →   kill / promote     →   evidence card + ship
```

### Why "clean room"

Prior work in this repository named specific models (e.g. DeepSeek V4,
Qwen 3.7), quoted prices, and recommended panels. That work may be useful
historically, but it embeds assumptions we have not re-verified today:
catalog slugs change, prices move, models get superseded, and selection
rules written after seeing results invite hindsight bias.

**Clean room** means:

- Every model name, price, and score is pulled fresh from a public source
  on the day of the snapshot, with URL and date recorded.
- Selection rules are written **before** looking at which models rank where.
- No prior internal shortlist, seed panel, or "known good pair" is used as
  input.
- Prior internal conclusions about public data may inform *process* (what
  rules to follow) but not *facts* (which models to pick).

If the clean-room pass lands on similar panels to older docs, that is
informative convergence. If not, we learned the old lists were stale. Either
way the result is trustworthy.

---

## Part II — Glossary

Terms used throughout this report:

- **Panel.** A set of 2–4 models that all attempt the same coding task.
- **Ensemble.** A panel plus the machinery that merges answers (topology +
  judge).
- **Topology.** How the panel is arranged: parallel (all answer, then
  judge), cascade (cheap model first, escalate on failure), or best-single
  × K samples (the honesty baseline).
- **Judge / synthesizer.** The model that reads candidate answers and picks
  or merges them into one final answer.
- **Oracle (panel ceiling).** On a set of tasks: the pass rate you would
  get if a perfect referee always chose a passing candidate whenever any
  panel member passed. This is a *theoretical maximum*, not a fused score.
- **Headroom.** Oracle minus the best single panel member's pass rate.
  Headroom means members fail on *different* tasks — room for fusion to help.
- **Lineage.** The base model family and/or distillation teacher behind a
  model (e.g. two Qwen3-235B variants share lineage and tend to fail
  together).
- **Lineage veto.** Rule: at most one model per lineage family per panel.
- **Top-K backbone.** The panel formed by taking the K highest-scoring models
  on public aggregate benchmarks, subject to lineage veto. This is the default
  hypothesis, not a clever complementarity search.
- **Self-MoA / best-single × K.** One strong model sampled K times; keep the
  best answer. A mandatory baseline: if this beats every panel, the honest
  verdict is "route to one model, don't fuse."
- **Hypothesis card.** One committed page per ensemble config: pinned
  members, topology, judge, budgets, cost projection, falsifiable
  prediction, and kill condition. Written before any run.
- **Catalog snapshot.** A dated document listing every candidate model with
  verified slug, price, context, provider options, and provenance URLs.
- **Aggregate score.** A leaderboard summary (one number per model per
  benchmark), not per-task outcomes. Useful for shortlisting; insufficient
  for final panel ranking.
- **Candidate bank.** Saved table of every model's answers to every task,
  with pass/fail, tokens, cost, and truncation flags. Expensive to fill once;
  cheap to replay many ensemble configs against.
- **Calibration sweep.** Single-shot run of every shortlisted model on a fixed
  task manifest; produces the candidate bank and truncation audit.
- **Capture rate.** Fraction of panel headroom the fused pipeline actually
  realizes. If headroom is +10 pp and fusion scores +5 pp over best-single,
  capture is 50%.
- **Evidence card.** Dated public one-pager: measured score, cost, vs
  best-single and vs frontier anchor, with links to artifacts. Only Phase D
  produces these.

---

## Part III — Process rules (written before any model is chosen)

These rules are fixed **before** Step 2 (catalog enumeration). They encode
what public data can and cannot support, stated without reference to prior
internal experiment IDs:

### What public data is good for

1. **Shortlisting** — which models are roughly in the coding frontier band.
2. **Lineage tagging** — which models are likely clones of each other.
3. **Price and context filtering** — mechanical eligibility checks.
4. **Tiebreaking among near-ties** — when two models score within leaderboard
   noise (~2–3 percentage points), prefer different lineage and different
   *style* (reasoning vs code-specialist vs fast generalist).

### What public data is not good for

1. **Final panel ranking** — picking which specific combination beats others
   on unseen tasks. Public per-task outcome matrices are stale (6–12 months
   behind the model frontier) and selection overfits the tasks they contain.
   The honest default is **top-K by aggregate score**, not complementarity
   search over public pass/fail tables.
2. **Launch claims** — no score from this phase is publishable.

This asymmetry is also supported by published literature on test-time scaling
(e.g. Self-MoA: one strong model with multiple samples often matches or
beats heterogeneous panels at matched cost) and by standard ML practice
(selection on the same data you evaluate generalizes poorly).

### Hard constraints (vetoes)

Every panel must satisfy all of the following:

| Veto | Rule | Why |
|---|---|---|
| **Lineage** | At most one model per base family / teacher per panel | Clones fail on the same tasks; they look diverse by name |
| **Truncation** | Thinking models get an explicit 64k completion budget in the config, or are dropped if uneconomical | Models truncated mid-answer are unmeasurable, not weak |
| **Provider pin** | Each member is `model + provider + endpoint config`, written down and hashed | Same weights on different hosts behave differently |
| **Price sanity** | Projected panel cost per request ≤ ~⅓ of a frontier anchor's cost | Otherwise the eventual $/solve story has no room |

### Benchmark anchors for shortlisting

Use **unsaturated** public coding benchmarks only — benchmarks where top
models still have headroom and scores are not bunched above ~85%:

| Benchmark | Domain | Use for shortlisting |
|---|---|---|
| LiveCodeBench (rolling) | Algorithmic / hard functions | Primary coding aggregate |
| SWE-bench Pro | Repo bugfix | Repo-fix aggregate (Verified is deprecated) |
| Aider polyglot | Multi-language edit competence | Edit-format aggregate |
| Terminal-Bench | Agentic terminal tasks | Secondary; scaffold-confounded |

**Do not use** saturated micro-benchmarks (MBPP, HumanEval) as primary
anchors — small models score 60–76% with inflated panel headroom that does
not transfer to product domains.

**Do not** pick panels by maximizing the *union* of public pass sets ("cover
the most tasks"). That is complementarity search on historical task IDs and
overfits those specific tasks.

### Target and price envelope (fix before enumeration)

Write one paragraph before pulling the catalog:

- **Domain for first measurement:** algorithmic coding (standalone functions
  with deterministic grading) — the only domain where end-to-end harness +
  grading exists today without new engineering.
- **Panel size:** K ∈ {2, 3} for parallel hypotheses; K samples for the
  best-single baseline.
- **Price envelope:** panel members should collectively cost ≤ ~⅓ of a
  frontier closed model (e.g. GPT-5.5-class) per request at default budgets.
- **OSS only:** open-weights models accessible via OpenRouter or first-party
  APIs; no closed-model panel members for v0.

---

## Part IV — Phase A: clean-room hypothesis formation ($0)

Phase A produces three committed artifacts and spends no API money.

```
Step 1  Write selection rules (Part III above)     ← before any model names
Step 2  Enumerate the live catalog                  → catalog snapshot
Step 3  Gather public evidence per candidate        → same snapshot
Step 4  Shortlist 8–12 models by pre-written rules  → shortlist table
Step 5  Construct 3–5 panel hypotheses              → hypothesis configs
Step 6  Write hypothesis cards                      → labruns/…/hypotheses/
```

### Step 1 — Lock the rules (done in Part III)

No model names yet. The rules in Part III are the contract: if a model is
not on the shortlist, the reason must trace to a pre-written filter, not to
"it didn't feel right."

**Replacement rule (decide now):** if a expected model does not exist in the
catalog under any slug, replace it with the next-highest aggregate scorer
from a *different* lineage family. If a whole family has no verified
current-gen entry, a previous-generation bridge model holds that slot for one
cycle only, clearly labeled `bridge`.

### Step 2 — Fresh catalog enumeration

**Action:** Pull the live provider catalog.

**Sources:**

- OpenRouter models API (`https://openrouter.ai/api/v1/models`) — primary
  for OSS model discovery, pricing, context lengths.
- First-party provider pages where direct API access exists (DeepSeek,
  Moonshot/Kimi, Z.ai/GLM, MiniMax, NVIDIA) — for identity confirmation and
  alternate pricing.

**Mechanical filters (apply to every row):**

- Open-weights / open-source license (exclude closed-only endpoints).
- Model card or vendor listing updated within ~6 months (exclude stale
  endpoints still listed but unmaintained).
- Context length ≥ 128,000 tokens.
- Coding-capable per vendor claims (coding benchmark presence, "coder" in
  name, or explicit coding category).

**Do not filter by score yet.** This step is enumeration, not selection.

**Provider pinning decision (record in snapshot):**

OpenRouter can route the same slug through different upstream providers with
different quantization. For measurement reproducibility, pin the upstream
provider per model using OpenRouter's provider preferences
(`order` + `allow_fallbacks: false`). Record the pinned provider in the
snapshot. Treat first-party API endpoints as preferred when pricing and
identity are cleaner.

**Output:** `docs/fusion/catalog-snapshot-YYYY-MM-DD.md` (or `.yaml` +
companion prose) containing for every surviving candidate:

```yaml
slug: "<provider>/<model-id>"
display_name: "..."
retrieved_at: "2026-07-07"
source_url: "https://..."
pricing:
  input_per_m: 0.32
  output_per_m: 1.28
context_length: 131072
max_completion_tokens: 65536   # if known
reasoning_controls: "..."      # parameter name / variant suffix / implicit
providers:                     # OpenRouter upstream options
  - id: ...
    quantization: fp8
    is_pinned: true
license: open-weights
vendor_updated: "2026-06"
coding_evidence:               # filled in Step 3
  - benchmark: livecodebench
    score: ...
    harness: ...
    as_of: ...
    url: ...
lineage:
  base_family: "..."
  teacher: "..." | uncertain
  notes: "..."
aggregate_mean: null           # filled in Step 4
flags: []
```

### Step 3 — Public evidence per candidate

For each model in the snapshot, collect every available third-party aggregate:

| Source | What to record |
|---|---|
| LiveCodeBench leaderboard | Score, date, URL |
| Aider polyglot leaderboard | Score, date, URL |
| SWE-bench Pro leaderboard | Score, date, URL |
| Artificial Analysis / similar | Coding index if available |
| Vendor-reported benchmarks | Label as `vendor-claimed`, lower trust |

**Rules:**

- Record score + harness + date + URL for every datum. No number without
  provenance.
- If a model appears on zero third-party leaderboards, flag
  `aggregate: none`. It may enter diversity slots in Step 5 but never the
  backbone.
- Check benchmark saturation: if the benchmark's top-10 are all above ~85%,
  note `saturated: true` and do not use it as a primary anchor for that
  domain.
- Lineage: read model cards for base family and declared teacher. If
  uncertain, record `teacher: uncertain` — do not guess.

### Step 4 — Shortlist by pre-written rules

**Action:** Rank all snapshot candidates by a **simple unweighted mean** of
available unsaturated-benchmark aggregates. No weighting scheme — public
harnesses are not comparable enough to justify one.

**Output:** Shortlist table (8–12 models) committed in the snapshot doc:

| Rank | Slug | Aggregate mean | Families represented | Flags |
|---|---|---|---|---|
| 1 | ... | ... | deepseek-v4 | |
| 2 | ... | ... | qwen-3.7 | |
| ... | | | | |

Apply mechanical filters from Part III:

- Drop models above the price ceiling unless needed for diversity.
- Ensure at least one model ≤ $0.20/M input (cascade fodder candidate).
- Keep 0–2 `bridge` models (previous generation) only if they link to
  measurable calibrated data from an earlier cycle — label clearly.

**Do not** run complementarity search, oracle maximization, or phi-based
ranking over public per-task matrices in this step.

### Step 5 — Construct panel hypotheses

Public data cannot rank panels, so emit **3–5 named hypotheses** spanning
plausible shapes. Do not pick a single winner.

#### Standard hypothesis shapes

| ID | Name | Construction | What a later run tests |
|---|---|---|---|
| **H1** | Backbone | Top-K from shortlist under all vetoes; parallel topology + judge | The honest default; every other hypothesis must beat this |
| **H2** | Style-diverse | H1 with near-tie swaps for lineage/style spread (reasoning + code-specialist + generalist) | Whether structural diversity buys real headroom |
| **H3** | Cheap-first cascade | Cheapest competent shortlist member first; escalate to H1 panel on failure | Whether cascade wins on $/solve (implementation deferred until cascade wrapper exists) |
| **H4** | Self-MoA baseline | Strongest shortlist member alone, K=3 samples, execution-guided selection | Mandatory honesty check; if H4 wins, verdict is "route, don't fuse" |
| **H5** | Thinking-heavy (optional) | Two reasoning-class + one fast generalist, 64k budgets | Whether reasoning diversity pays at current prices |

#### Judge selection (decide explicitly per card)

Pick one judge family used across all hypotheses for comparability. Rules:

- Prefer a strong instruction-following model.
- Prefer a judge that is **not** a member of the panel being judged (a panel
  member as judge biases toward its own answer style).
- Pin the judge identity the same way as panel members.

Document the choice and any unavoidable overlap (e.g. if the strongest
available judge is also a shortlist member, note it and test with an
alternate judge in a sensitivity run later).

#### Topology defaults

- **H1, H2, H5:** Parallel panel → judge synthesis (all members answer
  independently; judge merges).
- **H3:** Cascade — cheap model answers first; full panel + judge only if
  cheap answer fails grading or self-reports low confidence. Write the
  escalation rule explicitly even if implementation is deferred.
- **H4:** Single model, K=3 samples, execution-guided best-of-N selection
  (no judge calls for selection; grade each sample, keep best).

### Step 6 — Hypothesis cards

**Location:** `labruns/<cycle>/hypotheses/<hypothesis-id>.md` (e.g.
`labruns/2026-q3/hypotheses/h1-backbone.md`).

**Format:** YAML front matter (machine-readable) + prose (human reasoning).

**Required fields:**

```yaml
hypothesis_id: h1-backbone
cycle: 2026-q3
status: draft                    # draft | ready | deferred | killed
topology: parallel_judge         # parallel_judge | cascade | exec_select
panel:
  - endpoint_id: ...
    slug: ...
    provider: ...
    identity_hash: ...           # sha256 of pinned behavior fields
    max_completion_tokens: 32768
judge:
  endpoint_id: ...
  slug: ...
  identity_hash: ...
  is_panel_member: false
sampling:
  temperature: ...
  k_samples: 1                   # 3 for H4
cost_projection:
  per_request_usd: ...
  sweep_60_tasks_usd: ...
prediction: "..."
kill_condition: "..."
expiry: 2026-11-07                # one model generation (~4 months)
provenance:
  catalog_snapshot: docs/fusion/catalog-snapshot-YYYY-MM-DD.md
  rules_version: ensemble-launch-clean-room-2026-07.md
```

**Prose section (same file):** why this hypothesis exists, which vetoes were
applied, what would falsify it, and what the shippable verdict is if it
wins or loses.

**Example predictions and kill conditions:**

| Hypothesis | Prediction | Kill condition |
|---|---|---|
| H1 | Beats best-single by ≥2 pp on calibration bank | H4 ≥ H1 → route, don't fuse |
| H2 | Beats H1 by ≥2 pp | H2 ≤ H1 → stop near-tie diversity swaps |
| H3 | ≥80% of H1 pass rate at ≤40% of H1 cost | Escalation rate >60% → cascade saves nothing |
| H4 | (baseline) | If H4 ≥ all panels → shippable routing verdict |
| H5 | Beats H1 on hard-difficulty task slice | H5 ≤ H1 on full bank → drop 64k reasoning bet |

---

## Part V — Phase A deliverables and definition of done

### Artifacts produced (all committed, $0 spent)

| Artifact | Path | Purpose |
|---|---|---|
| Selection rules | This report, Part III | Contract written before model names |
| Catalog snapshot | `docs/fusion/catalog-snapshot-YYYY-MM-DD.md` | Every candidate with provenance |
| Model registry | `python/fusionkit-lab/registry/<cycle>.yaml` | Pinned identities for downstream tooling |
| Hypothesis cards | `labruns/<cycle>/hypotheses/h*.md` | Falsifiable configs ready to run |

### Definition of done

Phase A is complete when all of the following are true:

1. Catalog snapshot exists with retrieval date; every shortlisted model has
   verified slug, current price, context, pinned provider, and at least one
   provenance URL (or an explicit `aggregate: none` flag).
2. Selection rules were not modified after the shortlist was computed (or
   any modification is recorded as a documented deviation with reason).
3. Shortlist has 8–12 models; aggregate ranking method is simple mean of
   unsaturated benchmarks only.
4. Five hypothesis cards exist (H3 may be marked `deferred` if cascade
   wrapper is not ready, but the card must still be written with the
   escalation rule).
5. Every panel passes all four vetoes (lineage, truncation budget, provider
   pin, price sanity) — checkable mechanically from registry lineage tags.
6. H4 (Self-MoA baseline) exists and is labeled mandatory.
7. Zero API spend; zero publishable claims.

---

## Part VI — Phase B: config materialization and smoke ($0 engineering)

**Prerequisite:** Phase A definition of done met. Hypothesis cards marked
`ready` (or `deferred` for H3 only).

**Question answered:** Do our hypothesis configs resolve in the real FusionKit
stack, and do the pinned model IDs actually respond?

Phase B spends no meaningful benchmark money — only optional cent-scale smoke
calls.

### Step B1 — Extend the model registry

Copy every pinned member and judge from hypothesis cards into
`python/fusionkit-lab/registry/<cycle>.yaml` as `ModelIdentity` records:
endpoint_id, provider, model slug, base_url, api_key_env, prices,
max_completion_tokens, escalated_completion_tokens, lineage, generation.

Run `fklab models list` and `fklab models show <id>` to verify parsing. Record
identity hashes on the cards — if a card hash and registry hash diverge, the
config drifted.

### Step B2 — Emit current consumer configs

For each non-deferred hypothesis, produce:

| File | Contents |
|---|---|
| `.routekit/router.yaml` | Explicit providers whose credentials and live catalogs produce namespaced model IDs |
| `.fusionkit/fusion.json` v4 | `router`, `ensembles.*.members`, `judge`, and optional `synthesizer` namespaced model IDs |
| Internal sidecar/eval YAML, when needed | `routekit_url`, namespaced model IDs (including the legacy internal `endpoint_ids` key), panel/judge/synthesizer IDs, and sampling/budget policy |

The product loader accepts only the per-repository v4 JSON path. Keep
maintainer-only sidecar YAML clearly labeled and pass it directly to the eval
consumer.

**H4 (Self-MoA):** one namespaced model, K=3 in sampling config, topology
`exec_select` — selection uses public tests then grades on private tests via
the existing execution-guided selection path.

**H3 (cascade):** if cascade wrapper does not exist yet, emit a stub config
marked `deferred` and skip B3 smoke for H3. Do not block H1/H2/H4/H5 on H3.

### Step B3 — Config validation (no API)

Mechanical checks before spending money:

- Every endpoint_id in the config exists in the registry.
- No two panel members share a lineage tag (re-run lineage veto).
- Judge is documented; panel-member overlap flagged on the card.
- Token budgets match card (32k default, 64k for thinking hypotheses).
- Config hash recorded on the hypothesis card (`config_sha256`).

### Step B4 — Smoke tests (optional but recommended, ~$0–1)

Per config, one trivial non-benchmark request through the real path:

```
fusionkit init                # once per disposable smoke repository
fusionkit serve               # reads .fusionkit/fusion.json v4
POST a single "write hello world" or one tiny algorithmic fixture task
```

**Pass criteria:**

- Model IDs resolve (no 404 / model-not-found).
- Streaming completes without malformed JSON mid-stream.
- Response returns within timeout.
- Spend ledger records the call.

**Fail actions:** fix slug, provider pin, or api_key_env; update catalog
snapshot + registry + card; re-hash. Do not proceed to Phase C with a config
that failed smoke on identity grounds.

### Step B5 — Measurement preregistration (lite)

Before Phase C, append to each hypothesis card (or add
`labruns/<cycle>/prereg-measurement.md`):

- Exact task manifest path and task count (e.g. ~60 LiveCodeBench-style tasks,
  date window, stdin-only filter).
- Default completion budget (32k) and escalation rung (64k) per model.
- Hard spend cap for the whole Phase C run (recommend **$75** first pass).
- Metrics: pass@1 per model, fused pass rate per hypothesis, best-single × K,
  truncation rate, $/task.
- Verdict rules copied from hypothesis card kill conditions.

This is not the sealed Confirm prereg of Phase D — it is a team-facing
commitment before the first billed sweep.

### Phase B deliverables

| Artifact | Path |
|---|---|
| Registry (complete) | `python/fusionkit-lab/registry/<cycle>.yaml` |
| Fusion configs | `labruns/<cycle>/configs/h*.fusion.json` |
| Smoke log | `labruns/<cycle>/smoke-results.md` |
| Measurement prereg | `labruns/<cycle>/prereg-measurement.md` |
| Updated cards | `status: ready` → `status: smoke_passed` |

### Phase B definition of done

1. Every non-deferred hypothesis has a committed fusion config.
2. Registry and configs agree on identity hashes.
3. Smoke passed for all non-deferred configs (or documented blocker with
   owner).
4. Measurement prereg committed with spend cap before any Phase C API call.
5. Still no publishable claims.

---

## Part VII — Phase C: first measurement and hypothesis adjudication (~$25–75)

**Prerequisite:** Phase B definition of done met.

**Question answered:** On tasks **we grade ourselves**, which hypotheses beat
the backbone, beat best-single × K, and justify promotion to Phase D?

**Domain for v0:** algorithmic only (LiveCodeBench-style tasks, deterministic
stdin/stdout grading). Repo bugfix and other domains require graders not yet
built — do not expand scope mid-Phase-C.

### Step C1 — Fix the task manifest

Use a committed, dated task list — not ad-hoc task IDs at run time.

**Requirements:**

- ~60 tasks (enough for directional signal; not launch-grade precision).
- Rolling date window: prefer tasks published in the last 6–12 months to reduce
  contamination risk.
- Stdin/stdout or harness-compatible format (loadable by existing
  `livecodebench_data.py` / `CandidateBank` path).
- Manifest committed before the run: `labruns/<cycle>/manifest-algorithmic.jsonl`
  with task_id, prompt hash, test count, difficulty if known.

**Do not** tune the manifest after seeing results. If the manifest is wrong,
abort, fix, and re-run as a new preregistered cycle — do not cherry-pick tasks.

### Step C2 — Calibration sweep (fill the candidate bank)

**Run:** every model in the **shortlist** (not just panel members — the full
8–12) answers every manifest task **once** at default budget (32k), with a
**64k escalation rerun** for any model flagged `thinking` in the catalog or
with >10% truncated rows at 32k.

**Mechanics:**

- Single-shot generation per model per task (no judge yet).
- Grade inline with the existing sandbox + stdout checkers.
- Persist incrementally: each row flushed as it completes (resumable on crash).
- Spend ledger: one JSONL row per API call; **hard stop at preregistered cap**.
- Retry provider mid-stream failures; log failures, never silently drop rows.

**Output artifacts:**

```
labdata/runs/<cycle>/calibration/
  sample_bank.jsonl          # or CandidateBank JSON — all models × tasks
  outcomes.csv               # flat per-row outcomes
  spend_ledger.jsonl
  truncation_audit.md        # per-model truncated %; >10% → refuse number
  run_manifest.json          # provenance, caps, git sha, manifest hash
```

**Cost model (order of magnitude):** 10 models × 60 tasks × ~$0.05–0.15/task
≈ **$30–90** depending on model prices and output length. First pass cap at
$75 is intentional friction.

### Step C3 — Truncation audit (gate before interpretation)

Per model, compute truncated-row percentage on the sweep.

**Standing rule:** if >~10% of rows are truncated at the practical budget, that
model's pass rate is **refused** for this cycle — not caveated, refused. Either
re-run at 64k escalation or exclude from panel interpretation.

Update hypothesis cards if a panel member fails truncation audit (swap to
next shortlist rank from a different lineage, or kill the hypothesis).

### Step C4 — Hypothesis replay (cheap — mostly judge calls)

The candidate bank is frozen. Replaying ensembles does **not** re-call panel
models except for H3 cascade if implemented end-to-end.

| Hypothesis | Replay method | New API spend |
|---|---|---|
| **H1, H2, H5** | Judge reads saved panel answers; synthesizes; grade fused output | Judge calls only (~$5–20) |
| **H4** | Best-of-N over saved K samples (or generate K samples in C2 for the one model) | $0 if K samples already in bank |
| **H3** | End-to-end cascade if wrapper exists; else skip | Variable |

**Baselines computed on the same tasks (mandatory):**

1. Each panel member alone (pass@1).
2. **Best single × K at matched cost** (Self-MoA) — strongest shortlist
   member, K samples, execution-guided selection.
3. **Oracle ceiling** per panel (diagnostic only — not a launch claim).

**Comparison metrics:**

- Fused pass rate vs best-single pass rate (absolute pp difference).
- Fused $/solved task vs best-single $/solved (using ledger costs).
- Capture rate: (fused − best_single) / (oracle − best_single) when oracle >
  best_single.

Record Wilson confidence intervals if reporting internally, but do not treat
~60 tasks as launch-grade precision — Phase C is **directional**.

### Step C5 — Apply kill conditions; promote survivors

For each hypothesis card, evaluate preregistered kill conditions against C4
results. Update card status:

| Status | Meaning |
|---|---|
| `killed` | Kill condition met; do not promote |
| `survived` | Beat kill threshold; eligible for Phase D |
| `inconclusive` | Too few tasks or CI too wide; may re-run with larger manifest in a new cycle |
| `routing_wins` | H4 or best-single beat all panels — shippable *routing* verdict, not fusion |

**Promotion rule to Phase D:** at most **1–2 hypotheses per domain** advance.
If H4 wins, Phase D for that domain becomes "ship routing preset" not "ship
fusion panel" — still a valid product outcome.

Write `labruns/<cycle>/phase-c-report.md`: tables per hypothesis, ledger
totals, truncation audit, kill/promote decisions with one paragraph each.

### Phase C deliverables

| Artifact | Path |
|---|---|
| Task manifest | `labruns/<cycle>/manifest-algorithmic.jsonl` |
| Candidate bank + outcomes | `labdata/runs/<cycle>/calibration/` |
| Phase C report | `labruns/<cycle>/phase-c-report.md` |
| Updated hypothesis cards | statuses: killed / survived / routing_wins |

### Phase C definition of done

1. Sweep completed under preregistered spend cap with full ledger.
2. Truncation audit applied; refused models excluded from interpretation.
3. Every non-deferred hypothesis scored against mandatory baselines on the
   same task set.
4. Kill conditions evaluated; promotion list (≤2) documented.
5. Still **no external launch claims** — internal directional numbers only.

---

## Part VIII — Phase D: launch-grade measurement and packaging (~$1–3k/cycle)

**Prerequisite:** Phase C promoted ≤2 hypotheses per domain.

**Question answered:** Can we publish a dated evidence card for a named
ensemble (or routing preset) on a benchmark we name?

Phase D is the **rigorous lab loop** in full: own task banks, train/validation
discipline inside Select, sealed Confirm holdout, one-shot Confirm runs,
evidence cards, and frozen product configs. It replaces guesswork with claims.

### Why Phase D is separate from Phase C

| | Phase C | Phase D |
|---|---|---|
| Tasks | ~60 public-manifest tasks | 120–300+ tasks per bucket, many harvested |
| Holdout | None (directional only) | Sealed Confirm set, never used in search |
| Claims | Internal only | Publishable evidence cards |
| Cost | ~$25–75 | ~$1–3k per domain cycle |
| Grader trust | Existing LCB sandbox | Grader audit (~50 verdicts, ≥95% accuracy) |

Skipping Phase D and marketing Phase C numbers would violate the standing
rule: test execution in the lab is an instrument, not a customer contract —
but **published** numbers require Confirm discipline.

### Phase D steps (summary)

Phase D follows the same step numbering as the full lab loop. Each step below
is self-contained; tooling target is `fklab` (see lab-loop implementation spec).

**D0 — Lock launch domain and promoted hypothesis**

- One domain per evidence card (start with algorithmic if repo bugfix grader
  is not ready).
- Freeze the promoted config from Phase C as the **starting finalist** — not
  re-opened with public complementarity search.

**D1 — Build task banks and audit graders**

Three buckets per domain:

| Bucket | Size | Use |
|---|---:|---|
| Screen | ~40–60 | Cheap model filtering (optional if Phase C shortlist suffices) |
| Select | ~120–200 | Candidate bank + offline topology/judge search |
| Confirm | ~150–300 | **Sealed** — one preregistered run for launch number |

Tasks harvested from real sources (recent commits, rolling LCB windows) — not
hand-written exam questions. Grader audit: human checks ~50 random verdicts;
≥95% accuracy before bank counts.

**D2 — Screen sweep (optional if Phase C already qualified pool)**

~$50–150: every candidate model on Screen set; truncation audit; qualified
pool 6–10 models. Skip if Phase C shortlist already satisfies this.

**D3 — Fill Select candidate bank**

~$300–800: qualified models × Select tasks × **K=3 samples** (K=5 for two
cheapest models). This is the main API spend. Incremental persistence,
spend ledger, budget cap.

**D4 — Offline ensemble search**

~$50–200 judge spend: replay saved answers; search panels × topologies × judge
prompts against the bank. **Mandatory baselines:** each member alone, best-single
× K at matched cost, frontier anchor for context.

**Selection discipline:** train/validation split *inside* Select; finalist cap
1–2 before looking at Confirm. Do not use public matrices for panel picks.

**D5 — Confirm run (the launch number)**

Per finalist (~$100–300 each):

1. Freeze config; hash everything.
2. Preregister: config, Confirm bank sha256, metrics, pass rule — **committed
   before the run**.
3. Run **once**, end-to-end, fresh — no bank reuse — on sealed Confirm tasks.
4. Compute pass rate + CI, vs best-single, vs best-of-N, vs frontier on $/solve.
5. **Pass rule:** fused ≥ best single **and** beats frontier on $/solve for
   the cost story.

**Confirm discipline:** if finalist fails, return to D4 on Select data — never
"tweak and re-run Confirm." Max 2 Confirm attempts per domain per cycle.

**D6 — Package and ship**

For each confirmed winner:

- **Named model id** (e.g. `fusionkit/algorithmic-v1`) bound to frozen config
  in `.fusionkit/`.
- **Evidence card** — dated, with expiry (~4 months / one model generation).
- **Kill-ledger entries** for failed hypotheses (publish negative results with
  links).
- Archive outcome matrices for future router training.

### Phase D deliverables

| Artifact | Path |
|---|---|
| Task banks (Select committed; Confirm manifest only) | `labdata/banks/…` + external Confirm storage |
| Confirm preregistrations | `labruns/<cycle>/<domain>/prereg-confirm-*.md` |
| Confirm run manifests | `labruns/<cycle>/<domain>/manifest-confirm-*.json` |
| Evidence cards | `docs/fusion/cards/<model-id>-YYYY-MM-DD.md` |
| Product config | `.fusionkit/<model-id>.json` |
| Card index (expiry tracking) | `docs/fusion/cards/index.json` |

### Phase D definition of done

1. At least one Confirm run passed preregistered pass rule on sealed tasks.
2. Evidence card published with expiry date and artifact links.
3. Frozen config loadable by `fusionkit serve`.
4. Failed hypotheses recorded in kill ledger.
5. **This is the first phase that may produce external claims.**

### Phase D failure modes (acceptable outcomes)

- **Routing wins:** best-single × K beats all panels on Confirm — ship a
  routing preset, not fusion. Document honestly on the card.
- **Domain deferred:** two failed Confirm finalists — domain does not launch
  this cycle. The system worked.
- **Grader blocked:** Confirm refused until grader audit passes — fix grader,
  re-bank, re-cycle.

---

## Part IX — End-to-end timeline and cost summary

| Phase | Duration (engineering order, not calendar) | API cost | Publishable? |
|---|---|---|---|
| A | Catalog + cards | $0 | No |
| B | Configs + smoke | ~$0–1 | No |
| C | Sweep + replay | ~$25–75 | No (internal only) |
| D | Full lab loop per domain | ~$1–3k | Yes (evidence cards) |

**Parallelism note:** Phase A–B can proceed for multiple domains on paper, but
Phase C should stay **one domain** until the algorithmic path is proven end-to-end.
Phase D repo-bugfix waits on docker patch-test grader (lab-loop Stage 8).

---

## Part X — What this plan does and does not claim

### Claims

- This is a **repeatable, auditable procedure** for drafting ensemble
  hypotheses from public data without contamination from prior internal lists.
- The procedure respects known limits of public data: shortlist yes, final
  rank no.
- The output is a **portfolio of falsifiable configs**, not a single
  recommended panel.

### Non-claims

- No hypothesis is asserted to beat any other before measurement.
- No hypothesis is asserted to beat the best single model before measurement.
- No score, pass rate, or $/solve figure from Phases A–C is publishable.
- No model name in a hypothesis card is guaranteed to exist until Step 2
  verifies it.

### Accepted failure modes (cheap to fix later)

- Wrong model slug discovered at smoke-test → update snapshot + card + registry.
- Wrong token budget → fix after calibration sweep truncation audit.
- Missing dark-horse model → caught on next catalog refresh cycle.
- H3 cascade deferred → H1/H2/H4/H5 still runnable without it.

### Not accepted

- Quoting hypothesis configs as product recommendations before Phase C runs.
- Modifying selection rules after seeing which models rank highest.
- Skipping H4 (the Self-MoA baseline) because "fusion is the product" — if
  one model wins, routing is the honest shippable answer.

---

## Part XI — Quick reference checklists

### Phase A checklist ($0)

```
[ ] Part III rules written and frozen (before any catalog pull)
[ ] Catalog snapshot pulled with date + URLs
[ ] Every candidate: slug, price, context, provider pin, lineage
[ ] Public aggregates collected with harness + date + URL per score
[ ] Saturated benchmarks flagged; not used as primary anchors
[ ] Shortlist 8–12: simple mean rank, no complementarity search
[ ] H1 backbone built from top-K + vetoes
[ ] H2 style-diverse swaps documented (near-ties only)
[ ] H3 cascade card written (defer ok, rule must be explicit)
[ ] H4 Self-MoA baseline present
[ ] H5 optional, 64k budgets if included
[ ] Judge chosen, pinned, overlap with panels noted
[ ] Five hypothesis cards in labruns/<cycle>/hypotheses/
[ ] Registry updated with pinned identities + lineage tags
[ ] Zero API spend confirmed
[ ] No external claims made
```

### Phase B checklist (~$0–1)

```
[ ] Phase A definition of done met
[ ] All pinned members + judge copied to registry/<cycle>.yaml
[ ] fklab models list/show passes; card hashes match registry hashes
[ ] Fusion config emitted per non-deferred hypothesis (labruns/<cycle>/configs/)
[ ] H4 uses exec_select topology; H3 stub marked deferred if no cascade wrapper
[ ] Mechanical validation: endpoint_ids, lineage veto, token budgets, config_sha256
[ ] Smoke test passed for each non-deferred config (or blocker documented)
[ ] prereg-measurement.md committed with manifest path, cap ($75), metrics, verdict rules
[ ] Cards updated to smoke_passed (or deferred with owner)
[ ] Still no publishable claims
```

### Phase C checklist (~$25–75)

```
[ ] Phase B definition of done met
[ ] manifest-algorithmic.jsonl committed before any API call
[ ] Calibration sweep: full shortlist × manifest, single-shot + 64k escalation
[ ] Incremental persistence + spend ledger; hard stop at preregistered cap
[ ] truncation_audit.md complete; >10% models refused (not caveated)
[ ] Hypothesis replay on frozen bank: H1/H2/H5 judge-only; H4 best-of-N
[ ] Mandatory baselines: each member, best-single × K, oracle (diagnostic)
[ ] Kill conditions evaluated; cards updated (killed / survived / routing_wins)
[ ] phase-c-report.md with promotion list (≤2 hypotheses)
[ ] Still no external launch claims
```

### Phase D checklist (~$1–3k per domain)

```
[ ] Phase C promoted ≤2 hypotheses; domain frozen (algorithmic first)
[ ] Task banks built: Screen / Select / Confirm; grader audit ≥95% on ~50 verdicts
[ ] Confirm manifest sealed externally; sha256 in prereg before run
[ ] Select candidate bank filled (K=3 samples; K=5 for two cheapest)
[ ] Offline search on Select with train/val split; finalist cap 1–2
[ ] Confirm prereg committed: config hash, Confirm bank hash, pass rule
[ ] Confirm run once per finalist — no bank reuse, no tweak-and-rerun
[ ] Pass rule: fused ≥ best single AND beats frontier on $/solve
[ ] Evidence card + frozen .fusionkit config + kill-ledger entries
[ ] cards/index.json updated with expiry (~4 months)
```

---

## Appendix — Relationship to other documents

This report is **self-contained** for the full A→D path. Other documents in
`docs/fusion/` describe adjacent work (rigorous lab loop, company strategy,
prior internal experiments). None of them are required reading, and none of
their model lists or scores should be used as inputs.

| Phase completes | Input to next phase |
|---|---|
| A | Hypothesis cards → Phase B config materialization |
| B | Fusion configs + prereg → Phase C calibration sweep |
| C | Surviving configs (≤2) → Phase D Confirm discipline |
| D | Evidence cards + product configs → ship |

For tooling details beyond this report (schemas, `fklab` commands, bank
storage), see `docs/fusion/lab-loop-implementation-spec-2026-07.md`.
