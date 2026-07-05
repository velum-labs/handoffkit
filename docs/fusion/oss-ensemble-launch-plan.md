# OSS Ensemble Launch Plan

**Status:** adopted 2026-07-05 (supersedes the generic "active next steps"
list that previously lived in `capability-index-status.md`)
**Audience:** anyone joining the project — every term is explained where it
first appears; no prior context is assumed beyond "we combine LLMs to solve
coding tasks."
**Evidence base:** the Phase-0 validation study
(`docs/fusion/phase0-validation-report.md`, artifacts in `analysis/phase0/`).
Every claim below cites where it comes from.

---

## 1. What we are trying to do, in plain words

**Product vision.** People should be able to get frontier-level coding
performance at a fraction of frontier prices by using an **ensemble** —
several cheaper open-source (OSS) models working on the same task, whose
outputs are merged ("fused") into one answer. The user experience is a
single model: you send one request, you get one answer; the fanout and
merging happen behind the scenes.

**First launch.** A CLI where users can:

1. **Build their own ensembles** from any mix of local models, cloud APIs,
   and existing subscriptions (ChatGPT, Claude). The infrastructure for
   this — running any combination of models under most coding harnesses —
   already exists in HandoffKit and is considered solved.
2. **Use our predefined ensembles** — curated combinations that are consumed
   as one model and come with a documented, evidence-backed strength (for
   example "best at repository bug fixing").

**The open problem this plan addresses.** We do not yet know *which models
to put together, for which kinds of coding work, and how to prove the
combination is worth using*. That is what the steps below produce, in
order, with an explicit cost and an explicit decision at each step.

---

## 2. The concepts you need (glossary)

These six ideas carry the whole plan. Everything else is detail.

- **Ensemble / panel.** A set of K models (typically 2–4) that all attempt
  the same task. We use "panel" for the set of models and "ensemble" for
  the panel plus the merging machinery.

- **Fusion / synthesis.** How the panel's K candidate answers become one
  answer. The simplest form is *selection* (a judge model picks the best
  candidate). The stronger form is *synthesis* (a model reads all
  candidates and writes a final answer that can combine parts of several).
  Our product does synthesis.

- **Oracle.** The panel's theoretical ceiling: the score you would get if,
  on every task, a perfect referee always picked a passing candidate
  whenever any member produced one. Nobody achieves the oracle in
  practice; it measures *potential*.

- **Headroom.** Oracle minus the best single member's score. If the best
  member alone solves 60% of tasks and the oracle is 72%, headroom is
  +12 points: that is how much the other members *could* add. Headroom is
  the reason ensembles can work — it exists only when members fail on
  *different* tasks (complementary errors).

- **Capture rate.** The fraction of headroom your actual fusion pipeline
  realizes. If headroom is +12 points and the fused answer scores +6 over
  the best member, capture is 50%. **This is the single most important
  number for the business**: headroom is the market opportunity, capture
  is our take of it. Notably, synthesis can in principle exceed 100%
  capture (combining two half-right answers into one right one) — we saw
  this once in Phase 0 (fused 38.6% vs oracle 35.1%,
  `analysis/phase0/c3_transfer_report.md`) and confirming it cleanly is a
  major goal below.

- **Peer field vs lopsided field.** A domain is a *peer field* when several
  models score close to each other, and *lopsided* when one model dominates
  (say +30 points over the runner-up). Ensembles only make sense in peer
  fields: in a lopsided field the dominant model already solves nearly
  everything the others can, so headroom is tiny and the right move is to
  route to the single winner. This is not a hypothesis — we measured it
  (§3, finding 3).

---

## 3. What we already know (so we don't re-learn it)

Phase 0 was a set of pre-registered experiments run in July 2026 for a
total of ~$18 in API spend. Four findings bind this plan:

1. **Complementary errors are real and material among peers.** On public
   per-task data across three independent sources, the best 2–3 model
   panels show +8 to +12 points of headroom over their best member — and
   OSS-heavy panels showed the most (+11.3pp on LiveCodeBench with
   Qwen3 + DeepSeek + Kimi; +23pp on MBPP-class tasks). Evidence:
   `analysis/phase0/c1_c2_report.md` (checkpoint C1).

2. **Public benchmark data cannot pick the panel for you.** We tested,
   with held-out splits on seven datasets, whether choosing members by
   measured error-complementarity beats simply taking the top-K models by
   average score. It never did, and sometimes lost. Public data is good
   for *shortlisting* candidates and *vetoing* obviously redundant pairs —
   not for the final pick. The final pick must come from runs we do
   ourselves. Evidence: `c1_c2_report.md`, `c2v_report.md` (checkpoints
   C2, C2V — settled).

3. **Lopsided fields kill ensembles; peer fields are where we live.** When
   we ran a live pilot on single-shot algorithmic tasks, gpt-5.5 (closed)
   scored 80%, +38 points over the next model, and no panel added more
   than ~2 points. Since our panels are OSS-first, the practical
   consequence is: *check the field shape first; where a closed model
   dominates, the OSS ensemble's target is "beat the price," not "beat the
   score."* Evidence: `analysis/phase0/c3r16k_report.md`.

4. **Measurement has two traps we already fell into and fixed.**
   (a) *Truncation:* thinking-style models (e.g. kimi-k2-thinking) produce
   invalid, garbage-looking results unless given ≥16k — often ≥32k —
   completion tokens; any pass-rate with >10% truncated rows must be
   refused. (b) *Trust but recompute:* both major corrections in Phase 0
   came from recomputing numbers from raw run artifacts, not from reading
   reports. Both rules are binding on every run below. Evidence:
   `c3r16k_report.md`, decision log D3 in `capability-index-program.md`.

And one directional observation worth real money if it replicates:
**synthesis fusion once beat the oracle** (§2, "capture rate"). If our
fusion can reliably exceed the selection ceiling, the product claim
upgrades from "cheaper" to "better *and* cheaper."

---

## 4. The strategy: a funnel, not a matchmaking algorithm

The naive framing of our problem is "compute which models pair best."
Phase 0 showed that framing is wrong (finding 2): no amount of public-data
cleverness ranks pairings reliably. The correct framing is a **funnel of
progressively more expensive and more trustworthy tests**, where bad
combinations get eliminated cheaply and only survivors reach the expensive
stages:

```
STAGE 1 · Domain & shortlist scan          cost: ~$0 (public data)
   "Where are the peer fields, and which ~8 OSS models matter in each?"
        │  filters: peer field? headroom evidence? user demand?
        ▼
STAGE 2 · Calibration pilots               cost: ~$10–50 per domain
   "On ~60 tasks in OUR harness: real headroom, real capture,
    ensemble vs best member vs frontier baseline"
        │  gate: fused ≥ best member, and cost-per-solve beats frontier
        ▼
STAGE 3 · Full benchmark confirmation      cost: ~$100–500 per survivor
   "Official benchmark, full task set, public-grade numbers"
        │  gate: the launch sentence is true with CIs
        ▼
STAGE 4 · Launch card                      cost: writing it up
   "Ensemble E scores X% on benchmark B at $Y/solve —
    model M scores X'% at $3Y/solve"
```

Two properties make this work:

- **Stage 2 is absurdly cheap.** Our full Phase-0 pilot (5 models × 60
  tasks, graded end-to-end in our own harness, plus a judge replay) cost
  $5.56. "We can't afford to test combinations" is false; we can afford to
  test dozens.
- **Each stage answers a different question, so no stage needs more rigor
  than its job requires.** Stage 1 only shortlists → eyeballing tables is
  fine. Stage 2 only decides what goes to Stage 3 → a one-paragraph
  pre-registration and a held-out check suffice. Stage 3 backs a public
  claim → full rigor (official harness, CIs, published artifacts) applies
  there and only there.

---

## 5. The steps, in execution order

Each step states: the question it answers, why it is next, exactly what to
do, what it costs, and what each possible outcome means. Steps 1–3 are
independent enough to run in parallel; 4–6 depend on their predecessors.

### Step 0 — Record the OSS-first scope (done with this commit)

Panels are OSS-first; closed frontier models (gpt-5.5, Claude, Gemini)
serve as **routing baselines and price anchors, not panel members**. This
changes the selection universe everywhere downstream and is recorded as
decision D8 in `capability-index-program.md`.

### Step 1 — OSS peer-field scan (~$0, public data)

**Question:** for each coding domain, is the OSS field peer-shaped or
lopsided, and who are the top ~8 OSS candidates?

**Why now:** every later step needs a shortlist, and this is free. It is
also the direct answer to "which domains should we build ensembles for."

**What to do:** reuse the Phase-0 loaders
(`analysis/phase0/scripts/analyze_c1_c2.py` already parses LLMRouterBench,
SWE-bench submissions, and Terminal-Bench) but restrict the universe to
OSS models. Produce one table per domain — algorithmic, repo bugfix,
terminal/agentic, plus whatever the sources cover — with columns:

| model | avg score | gap to #1 | lineage (base/teacher) | host options |

Then apply the three filters from §4: (a) *peer field?* — flag lopsided if
#1 leads by >15–20 points; (b) *headroom evidence?* — compute best-panel
oracle/headroom exactly as C1 did; (c) *demand?* — judgment call, weighted
toward repo bugfix and agentic work.

**Lineage veto (important OSS-specific detail):** many OSS models are
distilled from the same frontier teachers and therefore fail on the same
tasks while looking "diverse" by name. The scan must record each model's
ancestry (base model, known teacher) and the veto rule is: no two panel
members sharing a base or teacher unless their measured failure
correlation is demonstrably low.

**Outcome interpretation:** domains that are OSS-peer-shaped *and* show
headroom go to Step 3 pilots. Lopsided-by-a-closed-model domains are still
in play — but the pilot question there becomes "does the OSS ensemble
approach the closed leader at much lower cost," not "does it win."

**Deliverable:** `analysis/oss-scan/report.md` + CSV tables, one
shortlist of 6–8 models per viable domain.

### Step 2 — Fix the invalid measurements: thinking models at ≥32k (~$8)

**Question:** what do kimi-k2-thinking and claude-sonnet-class models
*actually* score when not truncated?

**Why now:** two of our committed default panel members have never been
validly measured (52/60 completions truncated even at 16k tokens —
finding 4a). Every shortlist and every pilot that includes a thinking
model inherits this bug until it is fixed. It is one config change to an
existing script.

**What to do:** re-run `analysis/phase0/scripts/c3_transfer_pilot.py` on
the same 60-task slice with `max_tokens=32768` for the affected models
only. Record per-row truncation as required by D3; refuse the number if
>10% of rows still truncate (and escalate to 64k once).

**Outcome interpretation:** this either promotes or demotes kimi/sonnet in
every OSS shortlist from Step 1. There is no bad outcome; it converts two
unknowns into data either way.

**Deliverable:** appended rows in a new `analysis/thinking-32k/` round,
plus updated beliefs table in `capability-index-status.md`.

### Step 3 — The flagship capture pilot (~$30–50) ← the most important step

**Question:** when our real synthesis pipeline fuses a real OSS peer
panel on a domain with headroom, (a) how much of the oracle headroom do we
capture, and (b) does the fused result beat a closed frontier model on
cost-per-solve?

**Why this is the centerpiece:** every strategic question the company has
reduces to this table (one row per contender, on the same ~60-task slice):

| row | what it tells us |
|---|---|
| each panel member alone | the peer-field shape, for real, in our harness |
| **fused ensemble (one answer)** | what users actually get |
| oracle ceiling | the headroom that existed |
| closed frontier baseline (e.g. gpt-5.5 / sonnet) | the thing we claim to beat on price |

From those rows fall out: capture rate (fused vs oracle), the launch
sentence (fused vs frontier, score and $/solve), and whether the
synthesis-beats-oracle observation replicates. It is the direct,
quantitative answer to brainstorm questions 2 and 4 ("can we compare our
ensembles to other options" / "can ensembles beat closed frontier models").

**What to do:**

1. Pick the domain from Step 1 — expected winner is **repo bugfix**
   (highest headroom evidence at C1) if the HandoffKit patch-and-test
   path can grade it; otherwise **OSS-only algorithmic** (harness already
   proven by C3, and with gpt-5.5 excluded from the panel the field may
   well be peer-shaped — Step 1 confirms).
2. Panel = top 3–4 OSS models from the Step-1 shortlist after the lineage
   veto; budgets per finding 4a (≥32k for thinking models).
3. Write a one-paragraph pre-registration *before running*: task slice,
   panel, judge protocol, pass rule. Phase-0 templates:
   `analysis/phase0/c3_plan.md`, `c2v_preregistration.md`.
4. **Judge protocol hygiene** (this is what made the earlier
   synthesis-beats-oracle result only "directional"): candidates must be
   anonymized and order-randomized, and the judge/synthesizer must not
   receive anything that leaks which model wrote which candidate or any
   verbatim reference answer.
5. Run members → run fusion → grade everything with the same grader →
   compute the table with clustered bootstrap CIs (machinery exists in
   `analyze_c1_c2.py`).

**Gate (pre-registered, honest but not maximal rigor):** the pilot
*passes* if fused ≥ best member (point estimate) **and** fused
cost-per-solve beats the frontier baseline's. It passes *impressively* if
the fused-vs-best-member CI lower bound clears 0. Anything that fails
goes back to Step 1 with a different panel or domain — at $30 a shot,
iteration is the plan, not a failure mode.

**Deliverable:** `analysis/capture-pilot-1/` with pre-registration,
outcome CSVs, spend ledger, and a report; the capture-rate belief lands in
the status doc.

### Step 4 — Repo-bugfix harness unlock (engineering, no API cost)

**Question:** can we run patch-and-test grading (SWE-bench-style) under
our own harness end-to-end?

**Why:** C1 says the biggest peer-panel headroom lives on repo/agentic
tasks, and the launch-credibility benchmarks (SWE-bench Verified) live
there too. The Phase-0 harness inventory
(`analysis/phase0/harness_inventory.md`) found only the algorithmic
domain fully runnable — but that predates treating HandoffKit's
orchestration as the runner, which the user-facing product already does.
This step reconciles the two: wire HandoffKit's patch-and-test path into
the calibration machinery so Step-3-style pilots can run on repo tasks.

**Order note:** if this unlock turns out to be quick, do it *before*
Step 3 and run the flagship pilot on repo bugfix directly. If it drags,
run Step 3 on algorithmic first — a capture-rate number on an imperfect
domain this week beats a perfect domain next month.

**Deliverable:** a repo-bugfix pilot config that `c3_transfer_pilot.py`'s
successor can execute, demonstrated on ~10 tasks.

### Step 5 — Full benchmark confirmation (~$100–500, survivors only)

**Question:** does the winning ensemble's pilot result hold on an
official, full-size, unsaturated benchmark?

**What to do:** take the Step-3 winner *unchanged* — same members, same
judge protocol, frozen before the run — and execute the full task set of
the matching public benchmark (SWE-bench Verified for repo bugfix;
Terminal-Bench for agentic; LiveCodeBench current window for
algorithmic — rolling benchmarks preferred because wins there cannot be
dismissed as training-data contamination). Grade with the official
harness. Publish every artifact (configs, raw outputs, spend ledger) so
the result is reproducible by outsiders.

**Why unchanged matters:** if we tune the ensemble on the benchmark we
report, we are doing the thing we criticize. The pilot picks; the
benchmark confirms. Full statistical rigor applies here — this number
goes in marketing.

**Gate:** the launch sentence (§4, Stage 4) is true with confidence
intervals. If it narrowly fails, one iteration loop back through Step 3
with the lesson learned is acceptable; a second failure means the domain
or panel is wrong, not the protocol.

### Step 6 — Launch card and CLI integration

**What ships:** the predefined ensemble as a selectable model in the CLI,
plus a public **evidence card** per ensemble:

- what it is (members, fusion method — at whatever detail we choose to
  disclose),
- what it is for (the domain, in user language),
- the Step-5 table: score and cost-per-solve vs best member and vs the
  frontier baseline, with CIs and links to artifacts,
- honest boundaries: domains where we measured *no* advantage (finding 3
  makes "don't use this for X, use single model Y" a credibility feature,
  not a weakness — no competitor says that).

**Deliverable:** launch. Everything after (more domains, more cards, the
per-task router) is the same funnel run again.

---

## 6. Decision gates at a glance

| Gate | Question | Pass → | Fail → |
|---|---|---|---|
| After Step 1 | ≥1 domain that is OSS-peer + has headroom + has demand? | pilot that domain | product pivots to "cheaper, near-frontier" framing only |
| After Step 2 | thinking models validly measured? | they may join shortlists | exclude them; note in status doc |
| After Step 3 | fused ≥ best member AND beats frontier $/solve? | Step 5 on this ensemble | iterate panel/domain (expected: 1–3 loops) |
| After Step 5 | launch sentence true with CIs? | ship (Step 6) | one loop to Step 3; second failure kills the domain |

## 7. The two metrics that matter (define once, use everywhere)

- **Pass rate:** fraction of tasks solved, on a stated benchmark, graded
  by the benchmark's official criterion. Internal diagnostics (oracle,
  headroom, capture, failure correlation) exist to *explain* pass rate
  movements, never to headline.
- **Cost per solved task ($/solve):** total spend on the run divided by
  tasks solved. This is the number that makes "cheaper" concrete and
  comparable. Every run — pilot or benchmark — records per-row token
  counts and cost so this is always computable. Latency is tracked but
  does not gate v1.

## 8. What we are deliberately NOT doing (and why)

- **Ranking panels from public data** — falsified twice (C2, C2V). Public
  data shortlists and vetoes only.
- **Chasing benchmark saturation** — frontier labs win that game; ours is
  the price-performance frontier, stated as a Pareto claim.
- **The learned per-task router** — real, but premature; v1 routes by
  domain rules ("this ensemble for repo bugfix; single model X for
  algorithmic"), which finding 3 already justifies.
- **Overall-SOTA claims at launch** — domain-specific cards only, until a
  Step-5 result actually supports something broader.
- **Max rigor everywhere** — rigor is staged to match the money at risk
  (§4). Pilots get pre-registration + held-out checks; only Step 5 gets
  the full apparatus.

## 9. Budget summary

| Step | Spend |
|---|---|
| 1 — OSS scan | ~$0 |
| 2 — 32k re-measure | ~$8 |
| 3 — capture pilot | ~$30–50 per iteration, expect 1–3 |
| 4 — harness unlock | engineering only |
| 5 — full benchmark | ~$100–500 per survivor |
| **Total to launch** | **≈ $150–700**, overwhelmingly Step 5 |

The asymmetry is the point of the funnel: nine-tenths of the spend
happens only after a combination has already proven itself twice.

## 10. How this document relates to the others

| Document | Relationship |
|---|---|
| `capability-index-status.md` | Living source of truth; its "next steps" now point here. Beliefs learned in Steps 1–5 land there. |
| `capability-index-program.md` | This plan's adoption is decision D8 (append-only log). |
| `capability-index-spec.md` | Reference design for the warehouse/analytics; its reduced-scope build (M1) continues in the background as Steps 1–3 mature the Phase-0 scripts into reusable code. |
| `phase0-validation-report.md` | Closed record; the evidence base cited throughout §3. |
