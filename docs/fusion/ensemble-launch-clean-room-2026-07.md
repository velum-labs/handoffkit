# Ensemble Launch — Clean-Room Plan (2026-07)

**Status:** working plan, adopted 2026-07-07.
**Reader:** anyone assembling the first FusionKit ensemble configs. No prior
documents are required; everything needed to start is in this report.
**Scope:** how to go from zero to a small portfolio of **ensemble
hypotheses** using only public information and zero billed benchmark runs.
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

### Two phases of the same problem

| Phase | Question | Rigor | Cost |
|---|---|---|---|
| **Now (this report)** | What panels should we *try first*? | Low — public data only | $0 |
| **Later (lab loop)** | Which panel can we *claim* and ship? | High — own task banks, sealed holdouts, evidence cards | ~$1–3k/cycle |

This report covers **only the first phase**. The rigorous successor process
(build task banks, Screen/Select/Confirm, publish dated evidence cards) is a
separate, later program. Nothing in this report produces launch claims.

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

## Part VI — What happens after Phase A (context only)

Phase A does not run anything. The following phases are listed so readers
know where this plan ends and the next work begins. **Do not start these
until Phase A definition of done is met.**

### Phase B — Convert cards to runnable configs ($0, engineering)

- Emit FusionKit fusion configs from hypothesis cards (panel endpoints,
  judge, sampling) in the shape the engine already consumes.
- Smoke-test each config with 1–2 trivial requests: model IDs resolve, keys
  work, streaming succeeds. Cost: cents.

### Phase C — First real measurement (~$25–75, first billed spend)

- **Calibration sweep:** run every shortlisted model single-shot on ~60
  algorithmic tasks (LiveCodeBench-style manifest); truncation audit per
  model; build a candidate bank (saved answers + pass/fail).
- **Hypothesis replay:** run H1/H2/H5 judge synthesis against the bank; H4
  from bank samples for free; compare all against best-single.
- **Verdict:** which hypotheses survive to the rigorous lab loop; which get
  `killed` per their card kill conditions.

Phase C produces the first numbers anyone on the team trusts — but still not
external launch claims. External claims require the full lab loop (sealed
Confirm, evidence cards, dated expiry).

---

## Part VII — What this plan does and does not claim

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
- No score, pass rate, or $/solve figure from this phase is publishable.
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

## Part VIII — Quick reference checklist

Use this when executing Phase A:

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

---

## Appendix — Relationship to other documents

This report is **self-contained** for Phase A execution. Other documents in
`docs/fusion/` describe adjacent work (rigorous lab loop, company strategy,
prior internal experiments). None of them are required reading for Phase A,
and none of their model lists or scores should be used as inputs.

When Phase A completes, hypothesis cards become the input to Phase B/C.
When Phase C completes, surviving configs enter the rigorous lab loop for
launch-grade measurement and evidence cards.
