# The Company Operating System (2026-07)

**Status:** the current company strategy and operating plan, adopted
2026-07-06.
**Reader:** anyone deciding what the company builds, measures, and ships.
No prior context is assumed: every term is explained where it first appears.
**Relationship to other docs:** the stage roadmap with market data and
margin math is `unicorn-roadmap-2026-07.md`; the model-refresh pipeline is
`strategy-rethink-2026-07.md` §5; program beliefs live in
`capability-index-status.md`.

---

## 0. The ideas you need before reading (glossary)

- **Panel / ensemble.** A set of 2–4 AI models that all attempt the same
  coding task. "Panel" = the set of models; "ensemble" = the panel plus the
  machinery that merges their answers.
- **Fusion / synthesis.** How the panel's several candidate answers become
  one answer. A "judge" model reads all candidates and either picks the best
  one (selection) or writes a new answer combining the best parts of several
  (synthesis). Our product does synthesis.
- **Routing.** Sending a task to a single model instead of a panel. Routing
  and fusing are both valid answers; part of our job is knowing which one to
  use for which task.
- **Oracle and headroom.** The oracle is the panel's theoretical ceiling: the
  score you would get if a perfect referee always picked a passing candidate
  whenever any member produced one. Headroom = oracle minus the best single
  member's score. Headroom is the *potential* an ensemble has; it exists only
  when members fail on different tasks.
- **Capture rate.** The fraction of headroom our real fusion pipeline
  actually realizes. If headroom is +12 points and our fused answer scores
  +6 over the best member, capture is 50%. This is the single most important
  quality number in the company: headroom is the size of the opportunity,
  capture is our take of it.
- **Topology.** The *shape* of an ensemble — how the models are arranged.
  Examples: all models answer in parallel and a judge merges; one cheap
  model answers first and the panel is called only if it seems unsure (a
  "cascade"); different models play different roles in a multi-step task
  (one plans, another writes code, a third reviews).
- **Evidence card.** A dated, public one-pager for one ensemble: what it is,
  what it is for, its measured score and cost on a named benchmark, versus
  the best single model and versus a frontier model, with links to raw
  artifacts so outsiders can check the numbers.
- **Calibration.** Running models on tasks in *our own* test harness to
  measure how they actually perform. This is how panels are selected: our
  experiments established that only our own measurements can rank panels
  reliably.
- **Telemetry.** The record of what happens when real users use the product:
  which models ran, what they produced, what the user did with the answer.
- **Routing table.** Our name for the accumulated decision policy: for each
  kind of task, which models to use, in which topology, and when to escalate
  from a cheap attempt to an expensive one. It is a living artifact that
  both our lab experiments and our production data continuously improve.

---

## 1. What the company is

### 1.1 The thesis, in plain words

Open-source models have become nearly as good as the expensive frontier
models at coding, while costing 30–150 times less per token. That gap
between "cheap and almost as good" and "expensive and slightly better" is
the opportunity: combine several cheap models so their combined answer
matches or beats the expensive model, sell that answer well below the
frontier price, and keep a healthy margin.

The hard part — and therefore the defensible part — is *knowing how to
combine them*. Which models? For which kinds of tasks? Merged in which
shape? When is one model alone the right call? These questions can only be
answered by measuring, continuously, in our own harness and from our own
product usage. The company that accumulates those answers faster than
models change owns the layer.

**The company is the owner of the best answer to "how do you combine cheap
models into expensive-quality coding help." That answer lives in the
routing table, and our lab and our product usage improve it every day.**

### 1.2 The claims we make

Every public claim is statistical and reproducible: "on benchmark B,
measured on date D, this ensemble solved X% of tasks at $Y per solved
task — here are the raw artifacts." Claims are produced offline in the
calibration lab, where test execution is our grading instrument. Each claim
carries an issue date and an expiry date, and is renewed by re-measurement
every model generation.

### 1.3 How we charge

Usage-based: customers pay per fused turn, like any API. The cost-per-solve
numbers appear in evidence cards as the *reason to buy* — proof that our
answers cost less per solved task than the alternatives.

---

## 2. How the company runs: two loops feeding one asset

The company operates as two connected loops. One is slow, careful, and
expensive per cycle; the other is fast, noisy, and nearly free per event.
Both write into the same place.

```
LAB LOOP (slow, rigorous, $30–500/cycle)      PRODUCTION LOOP (fast, noisy, ~free)
a new model generation is released             a user invokes the endpoint / CI / CLI
  → measure all candidates ourselves             → the task is fingerprinted (what kind
    (truncation-audited sweep)                     of task, what kind of repo)
  → test ensemble shapes end-to-end              → the routing table decides:
    (topology-aware pilot)                          single model | panel | escalate
  → publish evidence card (dated,                → everything is logged: candidates,
    with an expiry date)                            judge decision, what the user kept
  → publish "route, don't fuse"                       │
    verdicts (Kill Ledger)                            │
        │                                             │
        └────────────► THE ROUTING TABLE ◄────────────┘
          for each kind of task: which models, in which shape,
          at what escalation threshold — versioned and measurable
```

**The lab loop** is the disciplined experimental machinery we already run:
the refresh pipeline of `strategy-rethink-2026-07.md` §5, the
`fusionkit-evals` harness, and the pre-registration / spend-ledger /
truncation-audit conventions of the `analysis/` rounds. Its cycle time is
one model generation (~3–4 months) and its job is *trustworthy priors*:
which models are measurable, which panels have headroom, which topologies
capture it, at what cost.

**The production loop** is built next (§5 specifies exactly what it
records). Its cycle time is one user request and its job is *ground truth
about real work*: what tasks users actually bring, which answers they
actually keep, what fusion is actually worth outside the lab.

**The routing table** is where both loops compound. The lab gives it
starting values; production traffic corrects and sharpens them. A competitor
who wants to copy the table needs *both* our experimental history and our
traffic. That is the whole strategy in one object: the accumulated decision
policy is the product; the CLI, the endpoint, and the cards are the ways
customers touch it.

---

## 3. The expansion playbook

How we take on the first domain and every domain after it. (A "domain" is a
category of coding work: repository bug fixing, terminal/agentic work,
algorithmic problems, and so on.)

```
Domain #1 (now):  Peer field? → Headroom? → Demand? → Gradeable? → Sweep
                  → topology-aware pilot → Card → ships inside THE endpoint
Domains #2+:      Observed demand (telemetry, partner asks)
                  → Gradeable-enough? → Peer + Headroom (as filters)
                  → Sweep → topology-aware pilot → Card → routing-table entry
Standing checks:  Transfer Check (§6.3) · best-single-model-×-K baseline ·
                  "route, don't fuse" verdicts published in the Kill Ledger
Distribution:     the workflow surfaces (CI integration, the endpoint inside
                  existing coding agents); cards answer "prove it"
```

The reasoning behind each piece:

- **Domain #1 proves the physics once.** For the first domain (repo bugfix)
  we gate on the physics first — a field where several OSS models are
  comparably strong ("peer field"), measured headroom, real demand, and
  mechanical gradeability — because until one domain passes end-to-end, the
  company has no proven claim to distribute.
- **From domain #2 on, demand leads.** New domains come from what telemetry
  and design partners show people actually need; the physics gates then act
  as cheap filters ($0–50 to kill a candidate) before real money is spent.
  This keeps expansion pointed at revenue while keeping the kill discipline.
- **Pilots compare topologies, not just panels.** Every pilot tests at
  minimum: parallel fusion; a cascade; a role-based arrangement where the
  task shape allows it; and the honesty baseline — the best single model
  sampled K times at the same total cost. Whichever shape wins goes in the
  routing table. "Route to a single model" is a legitimate, shippable
  verdict and gets published like any other result.
- **One endpoint carries everything.** Users send tasks to one API/model id;
  domain detection, panel choice, and the route-vs-fuse decision happen
  behind the API. Domain-named presets exist only as aliases for power
  users and as anchors for the marketing cards.
- **Cards build trust; workflow surfaces build reach.** Developers adopt
  what appears inside their existing workflow — the CI integration that
  attempts red builds, the endpoint plugged into the coding agent they
  already use. The evidence card is what we show when someone asks for
  proof.

---

## 4. Operating guidelines (G1–G10)

Standing rules, written to be enforceable. Each has a named enforcement
mechanism.

**G1 — One endpoint.** Users send tasks to one API/model id; we decide
internally whether to route or fuse and with what. Domain-named presets are
aliases into the routing table. *Enforced by:* product review gate on any
new user-facing `fusionkit/<domain>` surface.

**G2 — Demand nominates, physics vetoes.** After domain #1, new domains come
from telemetry and design-partner evidence; the peer-field / headroom /
gradeable gates filter candidates. *Enforced by:* expansion proposals must
cite demand evidence before any sweep money is spent.

**G3 — Every turn is instrumented.** If the telemetry record (§5.1) cannot
be written, the request does not ship. This costs days to build now and
would be practically impossible to retrofit after scale — early traffic is
exactly the data the company will later need most. *Enforced by:* a CI
check on the gateway; the schema version is pinned.

**G4 — Every pilot compares topologies.** At minimum: parallel fusion, a
cascade, a role-based arrangement where applicable, and the
best-single-model-×-K baseline at matched cost. *Enforced by:* the
pre-registration template has a mandatory topology section.

**G5 — Published numbers expire.** Every evidence card carries an issue date
and an expiry: one model generation (~4 months) after issue. Expired cards
are pulled from marketing until re-measured. Models churn every quarter;
the expiry turns that churn into a credibility feature. *Enforced by:* card
format carries `issued` / `expires` fields; marketing may not cite expired
cards.

**G6 — Claims are statistical.** Public claims state measured pass rates and
cost-per-solve on named benchmarks with dates and confidence intervals
(§1.2). Test execution is a lab instrument. *Enforced by:* contract and
marketing review.

**G7 — Publish the Kill Ledger.** Every gate failure becomes a public
one-liner with a date and a link to the underlying run ("don't fuse X;
route to model Y"). Publishing what didn't work is cheap and compounds
trust. *Enforced by:* part of the closing checklist of every analysis
round.

**G8 — The judge is versioned from day 0.** The judge/synthesizer — today a
prompt and a model choice, later a trained model — is the component that
turns headroom into captured value. Its configuration is hashed and
recorded on every lab run and every production turn, so capture rate can
always be attributed to a specific judge version. *Enforced by:* judge
config hash is a required field in both data schemas (§5).

**G9 — The Transfer Check is a standing experiment.** Quarterly,
pre-registered, described in §6.3. It measures whether benchmark-derived
panel rankings predict per-customer results, and its number decides how
much weight presets vs per-customer calibration carry in the product line.
*Enforced by:* calendar; prereg written before each run.

**G10 — Rigor proportional to money at risk.** Cheap pilots get a paragraph
of prereg and a held-out check; numbers that will appear in marketing get
full statistical treatment.

---

## 5. The data specification (what we record, exactly, and why)

### 5.1 Per production turn — the record that feeds everything

Written by the gateway (`packages/cli/src/gateway.ts` /
`commands/ensemble-gateway.ts` path) for every request (G3):

| Field group | Fields | Why we need it |
|---|---|---|
| Task fingerprint | repo language(s); repo size bucket; framework signals; prompt token count; inferred task class + classifier version | Lets us learn which *kinds* of tasks benefit from which treatment — the rows of the routing table |
| Routing record | routing-table version; decision taken (route / fuse / escalate); topology used; which escalation trigger fired, if any | Lets us evaluate and improve the table's decisions after the fact |
| Per model call | model + provider + endpoint version; input/output tokens; latency; cost; truncation flag; mid-stream failure flag | Cost accounting, provider reliability, and the truncation discipline (a truncated candidate is not a valid measurement) |
| Candidates | full content of every candidate (content-addressed); the anonymized, randomized order in which the judge saw them | The left half of the outcome dataset (§6.2); order matters because judge bias is real |
| Judge record | judge config hash (G8); the decision; which candidate(s) contributed to the synthesized answer; the synthesized answer itself | Ties quality to a judge version |
| Acceptance signals | in descending value: (a) **edit distance between the answer we returned and the code the user actually kept** (measured at next repo state or session end); (b) patch applied vs discarded; (c) retry within the session; (d) session continued vs abandoned | The closest thing to ground truth that exists outside a lab. Signal (a) is the gold one: "kept unchanged" vs "kept with small edits" vs "rewrote entirely" is a fine-grained quality label |
| Stamps | timestamp; panel generation stamp; session id; consent/privacy flags | Reproducibility and policy compliance |

**Privacy:** candidate and synthesis bodies are the sensitive fields. The
first instrumented release ships with a retention policy, an opt-out, and a
hash-only mode (record hashes and metrics but not bodies) for customers who
require it.

### 5.2 Per lab run

The pre-registration document (written before results exist); per-row
outcomes with truncation flags; the spend ledger (JSONL, as in
`analysis/seed-audit-32k/spend_ledger.jsonl`); oracle / headroom / capture
per topology; field-shape statistics (peer-shaped vs dominated by one
model); lineage vetoes (no two panel members sharing a base model or
teacher); the generation stamp; the judge version. Rounds stay immutable
per the update protocol in `capability-index-status.md`.

### 5.3 The numbers the company steers by

| KPI | Definition | What it tells you |
|---|---|---|
| **Capture rate per judge version** | (fused score − best member) ÷ (oracle − best member), on the lab slice, per judge config hash | Whether our fusion is getting better at converting potential into results — the core quality trend |
| **$/solve per task class** | total spend ÷ tasks solved; computed in the lab and, via acceptance, in production | Whether the economic claim ("cheaper per solved task") stays true |
| **Time-to-fresh** | days from an OSS model's release to its inclusion/exclusion verdict in the routing table | How fast the refresh machinery turns; the velocity component of the moat |
| **Transfer coefficient** | rank correlation between card-level panel ranking and per-customer acceptance ranking (§6.3) | Whether benchmark evidence predicts customer reality |
| **Routed-vs-fused mix** | fraction of production turns the table sends to a single model | An honesty gauge on the fusion thesis itself — we want to see any drift first |
| **NRR / gross margin** | standard business definitions | Business health; targets in `unicorn-roadmap-2026-07.md` (NRR >120%, GM ≥60% rising toward ~80%) |

---

## 6. The proprietary pipelines (P-A … P-D)

"Pipeline" means a repeatable process with an owner, a trigger, a cost, and
an output.

### 6.1 P-A · The Refresh Loop

*Trigger:* a new OSS model generation appears (roughly every 3–4 months).
*Steps:* diff the provider catalog → shortlist ~8–12 models using vendor
aggregates, price, context length, and the lineage veto (logic already in
`analysis/oss-scan/scripts/oss_scan.py`) → run the truncation-audited sweep
(the `analysis/seed-audit-32k/` runner pattern, generalized) → run
topology-aware pilots on survivors → re-issue evidence cards, pull expired
ones, update the routing table.
*Cost today:* ~$30–70 of API spend per cycle, run by hand (stages 0′–2′ of
`strategy-rethink-2026-07.md` §5).
*Target:* time-to-fresh under 14 days with near-zero human attention.
*Engineering item:* robust handling of mid-stream provider failures
(deepseek-r1 had 10 JSON failures in the seed audit) before larger sweeps.

### 6.2 P-B · The Flywheel Loop

*Trigger:* nightly, once real traffic exists.
*Steps:* aggregate the day's production records (§5.1) → evaluate current
judge versions and escalation thresholds against acceptance-weighted
outcomes → propose improvements (initially prompt and threshold changes;
later, trained judge models) → promote improvements through lab evaluation
*before* they touch the routing table (production data proposes, the lab
disposes — this ordering keeps the noisy signal from steering directly).

The dataset this loop accumulates is unique by construction: several
candidate answers to the same real task *from competing vendors*, side by
side, plus the judge's decision, plus what the user actually kept. Model
labs see only their own outputs; gateways see traffic but no side-by-side
candidates, no judge decision, no acceptance signal. This dataset trains
the judge. *Milestone worth naming:* the first judge trained on production
data that measurably beats the prompt-only judge on capture — from that
day, matching our quality requires having our data.

### 6.3 P-C · The Transfer Check

*Trigger:* quarterly, pre-registered each time.
*Question:* do our benchmark-derived panel rankings predict which panels
work best for individual customers?
*Method:* take all customers with at least N accepted turns in the quarter
(N fixed in the prereg); compare the panel ranking implied by the relevant
evidence card with the ranking implied by each customer's acceptance rates;
report one number (a rank correlation).
*Use:* consistently high transfer → presets carry more of the product line;
consistently low transfer → the per-customer calibration service (running
the sweep on the customer's own repos and tuning their panel) becomes the
flagship. The number decides the emphasis; both products exist either way.

### 6.4 P-D · The Kill Ledger

*Trigger:* any gate failure in any round.
*Output:* a public, dated one-liner with a link to the run ("Panel X on
domain Y: fused below best member; verdict: route to model Z"). We already
have entries in hand from the completed experiment rounds. Zero engineering
cost, disproportionate credibility yield.

---

## 7. Benchmarking policy

Trustworthy evaluation in coding now lives in private held-out task sets,
contamination-resistant public benchmarks, and production data. We report
three evidence tiers and always say which tier a number comes from:

1. **Private time-segmented holdout** (strongest). Tasks built from recent
   (<6 months old) commits in licensed or partner repositories. A model
   cannot have memorized answers that did not exist when it was trained, so
   contamination is impossible by construction. This tier carries our
   headline claims.
2. **Public contamination-resistant benchmarks** (comparable). SWE-bench Pro
   — public split for iteration, held-out split for claims — plus
   LiveCodeBench-style rolling windows (tasks newer than model training
   cutoffs). This tier lets outsiders compare us to others.
3. **Production telemetry** (ungameable, but noisy). Acceptance rates and
   $/solve on real traffic, published in aggregate in a quarterly "state of
   the ensembles" note. This tier cannot be gamed by anyone — including us —
   which is exactly its value.

Standing measurement rules, binding company-wide: pre-registration before
every run; per-row truncation audit (any model with more than ~10%
truncated completions gets its number refused, not caveated); spend ledgers
on every billed run; the best-single-model-×-K baseline in every pilot;
judge inputs anonymized and order-randomized.

---

## 8. What compounds (A1–A6)

A "compounding asset" means: something that gets more valuable with time
and use, and that a well-funded competitor cannot buy or rebuild quickly.
Ranked by terminal value:

**A1 — The routing table.** Every lab cycle and every production turn makes
its decisions measurably better. Copying it requires both our experimental
history and our traffic. It is portable across model generations: when
panel members are replaced, the accumulated knowledge of task classes,
escalation thresholds, and topology fits carries over.

**A2 — The cross-vendor outcome dataset** (§6.2). Unique by construction;
the training set for A3.

**A3 — The judge/synthesizer.** Capture rate is our visible quality edge,
and the judge is what produces it. Panel members churn every generation;
the judge persists and improves.

**A4 — The calibration harness and its automation.** Every refresh cycle
makes the next one cheaper and faster; the measurable form is time-to-fresh.

**A5 — The evidence-card corpus and Kill Ledger.** A multi-year archive of
dated, reproducible, expired-and-renewed claims — including the negative
ones — cannot be faked retroactively by a new entrant.

**A6 — Per-customer calibration profiles.** Once we calibrate on a
customer's own repositories, the tuned panel and escalation policy become
part of their CI infrastructure; replacing us means redoing that work.

Model-specific artifacts — panel configs, model picks, individual cards,
per-generation numbers — are consumables that the pipelines regenerate on
schedule. Capital and attention go to A1–A6.

---

## 9. Sequencing — what to do, in what order

1. **Now.** Execute P0 of the roadmap: the Step 4 repo-grading harness; the
   fresh sweep (refresh pipeline stages 0′–1′); the capture pilot
   (stage 2′) comparing topologies and including the
   best-single-model-×-K baseline (G4). In parallel, two things that cost
   days now and would be impossible to retrofit later: implement the §5.1
   telemetry schema in the gateway, and start recording judge config
   hashes (G8).
2. **When the first card passes its gate:** ship the single endpoint and
   the CI wedge to design partners. Telemetry starts accumulating the
   outcome dataset from the first turn. Publish the Kill Ledger with the
   verdicts already in hand.
3. **After the first quarter of telemetry:** run the first Transfer Check
   (P-C); let observed demand nominate domain #2 (G2); publish the first
   quarterly note from tier-3 evidence.
4. **When the outcome dataset is large enough:** train the first judge on
   production data (P-B). When it beats the prompt-only judge on capture,
   matching our quality requires having our data.
5. **Every model generation thereafter:** P-A turns the crank — cards
   renew, expired ones are pulled, the routing table absorbs the new
   generation. The company's trajectory is the slope of four curves —
   capture rate, $/solve, time-to-fresh, and net revenue retention — and
   every guideline in §4 exists to protect one of them.

---

## 10. Standing watch items

Each assumption is paired with the instrument that measures it and the
pre-decided response if it breaks — so a broken assumption is a plan
change, not a crisis.

| Assumption | Measuring instrument | Response if it breaks |
|---|---|---|
| Fusion beats the best single model sampled K times at the same cost | The P0 pilots — the next ~$200 of API spend decides this | Shift the product weight to routing; A1/A4/A5 retain value |
| Several OSS models stay comparably strong each generation | Every P-A sweep re-measures the field shape | Fusion narrows to the domains where peers persist; routing and the evaluation/index line carry the rest |
| The OSS-vs-frontier price gap survives | Card-level $/solve vs the frontier anchor, every generation | The claim shifts from "cheaper" to "better than any single model" (capture >100%) — which is why synthesis R&D is never deferred |
| Benchmark rankings predict customer results | P-C, quarterly | Weight shifts from presets to the per-customer calibration service (a pre-planned fork) |
| Acceptance signals honestly proxy quality | Correlate acceptance vs lab pass/fail on overlapping tasks | Re-weight the signals; a proxy never headlines a public claim |
| Gateways stay out of fusion | Product announcements (OpenRouter/NotDiamond) | Speed and the outcome dataset are the defenses; ship P1 quickly |
| The trust brand holds | Every published number replicates when checked | The pre-registration discipline is permanent; one inflated claim would destroy A5 |

---

## 11. Artifact index

| Artifact | Path |
|---|---|
| This report | `docs/fusion/company-operating-system-2026-07.md` |
| Stage roadmap (P0–P3, market facts, margin math) | `docs/fusion/unicorn-roadmap-2026-07.md` |
| Model-refresh pipeline stages 0′–4′ | `docs/fusion/strategy-rethink-2026-07.md` |
| Living beliefs | `docs/fusion/capability-index-status.md` |
| Program history / decision log | `docs/fusion/capability-index-program.md` |
| Lab harness | `python/fusionkit-evals/` |
| Gateway (telemetry integration point) | `packages/cli/src/gateway.ts` |
