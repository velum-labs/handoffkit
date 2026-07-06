# The Company Operating System — from evidence engine to great company (2026-07)

**Status:** full strategy report, written 2026-07-06 after the founder
discussions that followed `strategy-rethink-2026-07.md` and
`unicorn-roadmap-2026-07.md`.
**Reader:** anyone deciding what the company builds, measures, and refuses to
do — not just the ensemble program. No prior context is assumed: every term
is explained where it first appears.
**Relationship to other docs:** turns the stage roadmap
(`unicorn-roadmap-2026-07.md`) into day-to-day operating rules; records the
critique ("red team") of the domain expansion playbook from
`oss-ensemble-launch-plan.md` §4–5 and how we fixed it; replaces the
"Card → CLI preset" expansion mechanic. Program beliefs stay in
`capability-index-status.md`; decisions proposed here (§10) are appended to
`capability-index-program.md` when adopted.

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
  Examples: all models answer in parallel and a judge merges (what we do
  today); one cheap model answers first and we only call the panel if it
  seems unsure (a "cascade"); different models play different roles in a
  multi-step task (one plans, another writes code, a third reviews).
- **Evidence card.** A dated, public one-pager for one ensemble: what it is,
  what it is for, its measured score and cost on a named benchmark, versus
  the best single model and versus a frontier model, with links to raw
  artifacts so outsiders can check the numbers.
- **Calibration.** Running models on tasks in *our own* test harness to
  measure how they actually perform, instead of trusting public leaderboards.
  Our Phase-0 experiments proved public data cannot pick panels for us
  (decision D2), so calibration is the only reliable selection method.
- **Telemetry.** The record of what happens when real users use the product:
  which models ran, what they produced, what the user did with the answer.
- **Routing table.** Our name for the accumulated decision policy: for each
  kind of task, which models to use, in which topology, and when to escalate
  from a cheap attempt to an expensive one. It is a living artifact that
  both our lab experiments and our production data continuously improve.

---

## 1. What the company is, and what it refuses to promise

### 1.1 The thesis, in plain words

Open-source models have become nearly as good as the expensive frontier
models at coding, while costing 30–150 times less per token. That gap
between "cheap and almost as good" and "expensive and slightly better" is an
opportunity: if you can combine several cheap models so that their combined
answer matches or beats the expensive model, you can sell that combined
answer for much less than the frontier price and still keep a healthy
margin.

The hard part — and therefore the defensible part — is *knowing how to
combine them*. Which models? For which kinds of tasks? Merged how? When is
one model alone actually better? Our experiments show these questions cannot
be answered from public benchmark data (D2, D12); they can only be answered
by measuring, continuously, in your own harness and from your own product
usage. The company that accumulates those answers faster than models change
owns the layer.

So: **the company is the owner of the best answer to "how do you combine
cheap models into expensive-quality coding help" — and that answer lives in
the routing table, which our lab and our product usage improve every day.**

### 1.2 What we refuse to promise (founder decision, 2026-07-06)

We do **not** sell verified or guaranteed correctness on any individual
request. Every claim we make is *statistical*: "on benchmark B, measured on
date D, this ensemble solved X% of tasks at $Y per solved task." We never
say "this specific patch is guaranteed correct."

Why this boundary exists, spelled out:

1. **Test suites cannot actually verify correctness.** A passing test suite
   proves "nothing that was covered broke," not "the fix is right." This is
   not a hypothetical concern: OpenAI stopped reporting SWE-bench Verified
   in February 2026 after finding that 59% of the audited hard tasks had
   test suites that rejected correct solutions, and independent audits found
   the grading infrastructure wrong on roughly a third of verdicts. If the
   benchmark industry cannot verify patches with full control of the
   environment, we cannot promise it per-request on customer repos we don't
   control.
2. **Billing on "tests passed" corrupts our own product.** If we charged per
   green build, our system would be optimized to make tests pass rather than
   to fix bugs — models are already known to game graders (some retrieve
   the expected fix from git history inside evaluation containers). We would
   be paying ourselves to cheat.
3. **A guarantee changes what we are legally and operationally.** "Here is
   the best answer available at this price" is a tool. "We guarantee the
   outcome" is an insurance contract, priced against flaky tests and
   environments we don't control.

Test execution still matters enormously — but as our *internal measuring
instrument* (grading experiments, measuring capture, producing evidence
cards), never as a promise attached to a customer request.

### 1.3 How we charge

Usage-based: customers pay per fused turn, like any API. The cost-per-solve
numbers appear in evidence cards as the *reason to buy* — proof that our
answers cost less per solved task than the alternatives — but never as the
billing unit itself.

---

## 2. The critique of our expansion playbook, and the fix

### 2.1 What the playbook said

Our launch plan proposed expanding to new task areas ("domains" — e.g. repo
bug fixing, terminal work, algorithmic problems) with this sequence:

> Peer field? → Headroom? → Demand? → Gradeable? → Sweep → Pilot → Card →
> CLI preset

Meaning: check the domain has several comparably-strong OSS models ("peer
field"), check ensembles have room to help ("headroom"), check people care
("demand"), check we can grade answers mechanically ("gradeable"); then
measure all candidate models ourselves ("sweep"), test the best panel
end-to-end ("pilot"), publish the evidence card, and ship the ensemble as a
selectable preset in the CLI.

We deliberately attacked this plan to find its weaknesses. Five attacks
landed.

### 2.2 The five attacks, and what we changed

**Attack 1 — the plan starts from physics, but revenue starts from demand.**
The two rigorous, quantified gates in the sequence are about whether
ensembles *can* win (peer field, headroom). The gate that determines whether
anyone *pays* — demand — is third in line and, by our own admission, "a
judgment call." We were spending statistical rigor on the physics and
guesswork on the market. Also, our domain categories are inherited from
benchmark datasets, not from how developers experience work: no developer
thinks "I have a repo-bugfix-class task"; they think "my build is red."
*Fix:* the ordering stays as-is only for domain #1 (where we must prove the
physics once). From domain #2 onward, the order inverts: observed demand —
what users actually invoke us for, what design partners ask for — nominates
candidate domains, and the physics gates act only as filters that can kill a
candidate, never as the source of ideas.

**Attack 2 — a "domain" measured on a benchmark may not describe any
particular customer.** Our own settled finding (D2) is that public benchmark
data cannot rank panels; you must calibrate on your own harness. The
uncomfortable extension: a panel ranked on *our* 60-task benchmark slice may
not be the best panel for one specific customer's codebase, which has its
own languages, frameworks, and failure patterns. If that is true, a
"repo bugfix" evidence card is honest marketing but not a per-customer
performance prediction. *Fix:* we made this an explicit, recurring,
pre-registered experiment (the Transfer Check, §7.3) instead of an unspoken
assumption. Its result decides a real strategy fork: if benchmark rankings
predict customer results, we scale the preset model; if they don't, the
per-customer calibration *service* becomes the flagship product and cards
become credibility marketing.

**Attack 3 — the "gradeable" gate points us at the most crowded
battlefield.** Domains where answers can be graded mechanically (run the
tests) are exactly the domains where benchmarks exist, where training-data
contamination is worst, and where every competitor already optimizes. The
most valuable coding work — ambiguous debugging, design decisions, code
review — is hard to grade, so the gate structurally never reaches it.
*Fix (partial):* the gate stays, because honest evidence cards require
mechanical grading and honest cards are our credibility. But we added a
second, explicitly weaker evidence tier: production acceptance signals
(did the user keep the answer?) can nominate and roughly evaluate domains
the lab cannot grade. Weaker evidence, clearly labeled as such.

**Attack 4 — evidence cards do not acquire customers, and presets push work
onto the user.** The playbook ends at "publish card, ship preset" — it
contains no distribution step. Developers adopt tools that appear inside
their existing workflow; they rarely change tools because of a confidence
interval. And a menu of per-domain presets (`fusionkit/repo-bugfix`,
`fusionkit/terminal`, ...) asks the user to diagnose their own task before
asking for help — which is precisely the classification job we claim to be
good at. *Fix:* one endpoint. The user sends their task; domain detection,
panel choice, and the route-vs-fuse decision happen behind the API. Named
presets survive only as aliases for power users and as anchors for the
marketing cards. Distribution happens through workflow surfaces (the CI
integration, the endpoint plugged into existing coding agents), never
through the card itself. The card is what we show when someone asks
"prove it."

**Attack 5 — the playbook silently assumes one ensemble shape.** Everything
was designed around: all panel members answer in parallel, a judge merges.
That shape fits tasks whose answer is a single artifact (a patch, a
function), because candidates are comparable objects. It fits badly on
long multi-step ("agentic") tasks, where each model produces a divergent
*trajectory* of actions — there is no meaningful way to merge step 7 of one
trajectory with step 3 of another. In such domains the headroom gate can
pass (the models do fail on different tasks) while fusion captures almost
none of it. *Fix:* pilots now compare topologies, not just panels — parallel
fusion, cascades (cheap model first, panel only on apparent difficulty),
role-based arrangements (different vendors for planning / writing /
reviewing within one workflow), and the mandatory honesty baseline: the best
single model sampled K times at the same total cost. "Route to a single
model, don't fuse" is a legitimate, shippable verdict.

### 2.3 The repaired playbook

```
Domain #1 (now):  Peer? → Headroom? → Demand? → Gradeable? → Sweep
                  → topology-aware pilot → Card → ships inside THE endpoint
Domains #2+:      Observed demand (telemetry, partner asks)
                  → Gradeable-enough? → Peer + Headroom (as filters only)
                  → Sweep → topology-aware pilot → Card → routing-table entry
Standing checks:  Transfer Check · best-single-model-×-K baseline ·
                  "route, don't fuse" verdicts published in the Kill Ledger
Distribution:     never the card — the workflow surfaces (CI, endpoint inside
                  existing agents); cards answer "prove it"
```

What the attacks did **not** break, and we keep unchanged: calibration-first
selection (settled three times: C2, C2V, OSS-only recheck), the gates as
cheap kill rules ($0–50 to kill a bad idea before spending real money), the
staged-rigor principle (spend statistical care in proportion to the money at
risk), and the playbook exactly as written for the first domain.

---

## 3. How the company runs: two loops feeding one asset

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
  → publish failures (Kill Ledger)                    │
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
which models are even measurable, which panels have headroom, which
topologies capture it, at what cost.

**The production loop** does not exist yet and must be built (§6 specifies
exactly what it records). Its cycle time is one user request and its job is
*ground truth about real work*: what tasks users actually bring, which
answers they actually keep, what fusion is actually worth outside the lab.

**The routing table** is where both loops compound. The lab gives it
starting values; production traffic corrects and sharpens them. A competitor
who wants to copy the table needs *both* our experimental history and our
traffic. That is the whole strategy in one object: neither the CLI, nor any
particular panel, nor any single card is the product — the accumulated
decision policy is.

---

## 4. Operating guidelines (G1–G10)

These are standing rules, written to be enforceable rather than
aspirational. Each has a named enforcement mechanism.

**G1 — One endpoint.** Users send tasks to one API/model id; we decide
internally whether to route or fuse and with what. Domain-named presets are
aliases into the routing table, never separately maintained products.
*Enforced by:* product review gate on any new user-facing
`fusionkit/<domain>` surface.

**G2 — Demand nominates, physics vetoes.** After domain #1, new domains come
from what telemetry and design partners show people actually need. The
peer-field / headroom / gradeable gates can only kill a candidate domain,
never propose one. *Enforced by:* expansion proposals must cite demand
evidence before any sweep money is spent.

**G3 — No un-instrumented turn, ever.** If the telemetry record (§6.1)
cannot be written, the request does not ship. This costs days to build now
and would be practically impossible to retrofit after scale — the early
traffic is exactly the data the company will later wish it had.
*Enforced by:* a CI check on the gateway; the schema version is pinned.

**G4 — Every pilot compares topologies, not just panels.** At minimum:
parallel fusion; a cascade (cheap model first, escalate on apparent
difficulty); a role-based arrangement where the task shape allows it; and
the honesty baseline — the best single model sampled K times at matched
total cost. If the single model wins, the shipped verdict is "route, don't
fuse," and that verdict goes in the card. *Enforced by:* the
pre-registration template gains a mandatory topology section.

**G5 — Published numbers expire.** Every evidence card carries an issue date
and an expiry: one model generation (~4 months) after issue. Expired cards
are pulled from marketing until re-measured. This turns our biggest
operational annoyance — models churn every quarter — into a credibility
feature no competitor bothers to copy. *Enforced by:* card format carries
`issued` / `expires` fields; marketing may not cite expired cards.

**G6 — Never promise per-request correctness.** The §1.2 boundary.
*Enforced by:* contract and marketing review.

**G7 — Publish the Kill Ledger.** Every gate failure becomes a public
one-liner with a date and a link to the underlying run ("don't fuse X;
route to model Y"). Publishing what *didn't* work is cheap, differentiating,
and compounds trust. *Enforced by:* part of the closing checklist of every
analysis round.

**G8 — The judge is versioned from day 0.** The judge/synthesizer — today
just a prompt and a model choice — is the component that turns headroom into
captured value, and later the component we train. Its configuration is
hashed and recorded on every lab run and every production turn, so capture
rate can always be attributed to a specific judge version. *Enforced by:*
judge config hash is a required field in both data schemas (§6).

**G9 — The Transfer Check is a standing experiment.** Quarterly,
pre-registered, described in §7.3. Its result decides the preset-vs-service
strategy fork with a number instead of a narrative. *Enforced by:* calendar;
prereg written before each run.

**G10 — Rigor proportional to money at risk.** Cheap pilots get a paragraph
of prereg and a held-out check; numbers that will appear in marketing get
full statistical treatment. (Existing rule, unchanged, restated here for
completeness.)

---

## 5. What compounds (A1–A6), and what deliberately does not

A "compounding asset" here means: something that gets more valuable with
time and use, and that a well-funded competitor cannot buy or rebuild
quickly. Ranked by terminal value:

**A1 — The routing table.** Every lab cycle and every production turn makes
its decisions measurably better. Copying it requires both our experimental
history and our traffic. It is also *portable across model generations*:
when panel members are replaced, the accumulated knowledge of task classes,
escalation thresholds, and topology fits carries over.

**A2 — The cross-vendor outcome dataset.** Each production turn logs several
candidate answers to the same real task *from competing vendors*, side by
side, plus the judge's decision, plus what the user actually kept. No model
lab has this (they see only their own model's outputs); no gateway has it
(they see traffic, but no side-by-side candidates, no judge decision, no
acceptance signal). It is unique by construction, and it is the training
set for A3.

**A3 — The judge/synthesizer.** Capture rate is our visible quality edge,
and the judge is what produces it. Panel members churn every generation;
the judge persists and improves. The day it is trained on A2 and measurably
beats the prompt-only version is the day matching our quality requires
having our data.

**A4 — The calibration harness and its automation.** Every cycle of the
refresh pipeline makes the next cycle cheaper and faster. The measurable
form of this asset is **time-to-fresh** (§8): how many days pass between a
new model's release and its verdict in our routing table.

**A5 — The evidence-card corpus and Kill Ledger.** A multi-year archive of
dated, reproducible, expired-and-renewed claims — including the negative
ones — cannot be faked retroactively by a new entrant. In a market that
just lost its referee (the SWE-bench Verified deprecation), being the
source whose numbers replicate is a durable position.

**A6 — Per-customer calibration profiles.** Once we calibrate on a
customer's own repositories (the P2 service), the tuned panel and
escalation policy become part of their CI infrastructure. Replacing us
means redoing that calibration.

**Deliberately treated as perishable inventory, not assets:** specific
panel configurations, specific model picks, individual evidence cards, and
all per-generation numbers. Our own finding D13 established that everything
model-specific goes stale in roughly one generation. Capital and attention
go to A1–A6; model-specific artifacts are consumables that the pipelines
(§7) regenerate on schedule.

---

## 6. The data specification (what we record, exactly, and why)

### 6.1 Per production turn — the record that feeds everything

Written by the gateway (`packages/cli/src/gateway.ts` /
`commands/ensemble-gateway.ts` path) for every request, without exception
(G3):

| Field group | Fields | Why we need it |
|---|---|---|
| Task fingerprint | repo language(s); repo size bucket; framework signals; prompt token count; inferred task class + classifier version | Lets us learn which *kinds* of tasks benefit from which treatment — the rows of the routing table |
| Routing record | routing-table version; decision taken (route / fuse / escalate); topology used; which escalation trigger fired, if any | Lets us evaluate and improve the table's decisions after the fact |
| Per model call | model + provider + endpoint version; input/output tokens; latency; cost; truncation flag; mid-stream failure flag | Cost accounting, provider reliability, and the truncation discipline (a truncated candidate is not a valid measurement) |
| Candidates | full content of every candidate (content-addressed); the anonymized, randomized order in which the judge saw them | The left half of the A2 dataset; order matters because judge bias is real |
| Judge record | judge config hash (G8); the decision; which candidate(s) contributed to the synthesized answer; the synthesized answer itself | The middle of the A2 dataset; ties quality to a judge version |
| Acceptance signals | in descending value: (a) **edit distance between the answer we returned and the code the user actually kept** (measured at next repo state or session end); (b) patch applied vs discarded; (c) retry within the session; (d) session continued vs abandoned | The right half of A2 — the closest thing to ground truth that exists outside a lab. Signal (a) is the gold one: "kept unchanged" vs "kept with small edits" vs "rewrote entirely" is a fine-grained quality label, and to our knowledge nobody logs it |
| Stamps | timestamp; panel generation stamp; session id; consent/privacy flags | Reproducibility and policy compliance |

**Privacy note:** candidate and synthesis bodies are the sensitive fields.
The first instrumented release must ship with a retention policy, an
opt-out, and a hash-only mode (record hashes and metrics but not bodies)
for customers who refuse content retention.

### 6.2 Per lab run — existing discipline, stated as a schema

Already our practice; listed so it is checkable: the pre-registration
document (written before results exist); per-row outcomes with truncation
flags; the spend ledger (JSONL, as in
`analysis/seed-audit-32k/spend_ledger.jsonl`); oracle / headroom / capture
per topology; field-shape statistics (is the domain peer-shaped or
dominated by one model); lineage vetoes (no two panel members sharing a
base model or teacher); the generation stamp; the judge version. Rounds
stay immutable per the update protocol in `capability-index-status.md`.

### 6.3 The derived numbers the company steers by

| KPI | Definition | What it tells you |
|---|---|---|
| **Capture rate per judge version** | (fused score − best member) ÷ (oracle − best member), on the lab slice, per judge config hash | Whether our fusion is getting better at converting potential into results — the core quality trend |
| **$/solve per task class** | total spend ÷ tasks solved; computed in the lab and, via acceptance, in production | Whether the economic claim ("cheaper per solved task") stays true |
| **Time-to-fresh** | days from an OSS model's release to its inclusion/exclusion verdict in the routing table | How fast the refresh machinery turns; the velocity component of the moat |
| **Transfer coefficient** | rank correlation between card-level panel ranking and per-customer acceptance ranking (§7.3) | Whether benchmark evidence predicts customer reality — decides the §2.2 Attack-2 fork |
| **Routed-vs-fused mix** | fraction of production turns the table sends to a single model | An honesty gauge: if this drifts toward 100%, fusion is not paying for itself and we want to be the first to know |
| **NRR / gross margin** | standard business definitions | Business health; targets live in `unicorn-roadmap-2026-07.md` (NRR >120%, GM ≥60% rising toward ~80%) |

---

## 7. The proprietary pipelines (P-A … P-D)

"Pipeline" here means a repeatable process with an owner, a trigger, a cost,
and an output — not an aspiration.

### P-A · The Refresh Loop — exists as manual stages; the work is automation

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
*Known engineering debt:* mid-stream provider failures (deepseek-r1 had 10
JSON failures in the seed audit) must be handled robustly before larger
sweeps.

### P-B · The Flywheel Loop — does not exist; build after first real traffic

*Trigger:* nightly.
*Steps:* aggregate the day's production records (§6.1) → evaluate current
judge versions and escalation thresholds against acceptance-weighted
outcomes → propose improvements (initially prompt and threshold changes;
later, trained judge models) → promote improvements through lab evaluation
*before* they touch the routing table (production data proposes, the lab
disposes — this ordering prevents the noisy signal from steering directly).
*Milestone worth naming:* the first judge trained on production data that
measurably beats the prompt-only judge on capture. From that day, matching
our quality requires having our dataset.

### P-C · The Transfer Check — a standing experiment, pre-registered each time

*Trigger:* quarterly.
*Question:* do our benchmark-derived panel rankings predict which panels
work best for individual customers?
*Method:* take all customers with at least N accepted turns in the quarter
(N fixed in the prereg); compare the panel ranking implied by the relevant
evidence card with the ranking implied by each customer's acceptance rates;
report one number (a rank correlation).
*Decision rule (pre-registered, not vibes):* consistently high transfer →
presets are real products and we scale them; consistently low transfer →
cards are demoted to credibility marketing and the per-customer calibration
service becomes the flagship P2 product. No middle-ground narrative without
the number.

### P-D · The Kill Ledger — pure discipline; start immediately

*Trigger:* any gate failure in any round.
*Output:* a public, dated one-liner with a link to the run ("Panel X on
domain Y: fused below best member; verdict: route to model Z"). We already
have entries in hand from Phase 0 and the OSS rechecks (e.g. "don't fuse
single-shot algorithmic; gpt-5.5 dominates"). Zero engineering cost,
disproportionate credibility yield — nobody else publishes their failures.

---

## 8. Benchmarking policy (in a world where the standard benchmark died)

Context: the industry's default coding benchmark, SWE-bench Verified, was
deprecated by OpenAI in February 2026 — its tests rejected correct solutions
on a majority of audited hard tasks, and frontier models were shown to have
memorized its answers. Trustworthy evaluation has moved to private held-out
task sets and production data. This is good for us: careful measurement is
our existing habit, and the vacuum is ours to fill.

We therefore report three evidence tiers, and always say which tier a
number comes from:

1. **Private time-segmented holdout** (strongest). Tasks built from recent
   (<6 months old) commits in licensed or partner repositories. A model
   cannot have memorized answers that did not exist when it was trained, so
   contamination is impossible by construction. This tier carries our
   headline claims.
2. **Public contamination-resistant benchmarks** (comparable). SWE-bench Pro
   — public split for iteration, held-out split for claims — plus
   LiveCodeBench-style rolling windows (tasks newer than model training
   cutoffs). This tier lets outsiders compare us to others. SWE-bench
   Verified is not cited in any public claim.
3. **Production telemetry** (ungameable, but noisy). Acceptance rates and
   $/solve on real traffic, published in aggregate in a quarterly "state of
   the ensembles" note. This tier cannot be gamed by anyone — including us —
   which is exactly its value.

Standing measurement rules, carried over from the program and made binding
company-wide: pre-registration before every run; per-row truncation audit
(any model with more than ~10% truncated completions gets its number
refused, not caveated); spend ledgers on every billed run; the
best-single-model-×-K baseline in every pilot; judge inputs anonymized and
order-randomized.

---

## 9. Sequencing — what to do, in what order, and why this order

1. **Now (the plan does not change).** Execute P0 of the roadmap: the
   Step 4 repo-grading harness; the fresh sweep (refresh pipeline stages
   0′–1′); the capture pilot (stage 2′) upgraded per G4 to compare
   topologies and include the best-single-model-×-K baseline. In parallel,
   two things that cost days now and would be impossible to retrofit later:
   implement the §6.1 telemetry schema in the gateway, and start recording
   judge config hashes (G8).
2. **When the first card passes its gate:** ship the single endpoint and
   the CI wedge to design partners. Telemetry starts accumulating A2 from
   the first turn. Publish the Kill Ledger with the negative results we
   already have.
3. **After the first quarter of telemetry:** run the first Transfer Check
   (P-C); let observed demand nominate domain #2 (G2); publish the first
   quarterly note from tier-3 evidence.
4. **When A2 is large enough:** train the first judge on production data
   (P-B). If it beats the prompt-only judge on capture, the company has
   crossed from "copyable idea" to "data-defended product."
5. **Every model generation thereafter:** P-A turns the crank — cards
   renew, expired ones are pulled, the routing table absorbs the new
   generation. The company's greatness is the slope of four curves —
   capture rate, $/solve, time-to-fresh, and net revenue retention — and
   every guideline in §4 exists to protect one of those curves.

---

## 10. Decisions proposed for the program log (to append when adopted)

| Proposed | Content |
|---|---|
| D15 | Positioning boundary: statistical claims only; no per-request verification promises; usage-based pricing (§1.2–1.3) |
| D16 | Benchmark retarget: SWE-bench Verified retired from public claims; three-tier evidence policy adopted (§8) |
| D17 | Playbook repair: demand-first expansion after domain #1; one endpoint; topology-aware pilots; best-single-model-×-K baseline mandatory (§2.2–2.3, G1–G4) |
| D18 | Telemetry mandate: the §6.1 schema is required before any public traffic (G3); the Transfer Check is a standing quarterly experiment (G9) |
| D19 | Card expiry: evidence cards expire one model generation after issue; expired cards are pulled from marketing (G5) |

---

## 11. Risks and standing watch items

Each assumption is paired with the instrument that measures it and the
pre-decided response if it breaks — so that a broken assumption is a plan
change, not a crisis.

| Assumption | Measuring instrument | If it breaks |
|---|---|---|
| Fusion beats the best single model sampled K times at the same cost | The P0 pilots — the next ~$200 of API spend decides this | The thesis is routing-only: pivot to routing or stop. A1/A4/A5 retain value; A2/A3 do not |
| Several OSS models stay comparably strong each generation ("peer fields persist") | Every P-A sweep re-measures the field shape | If one model dominates everything, the fusion layer collapses to routing; the evaluation/index business survives |
| The OSS-vs-frontier price gap survives | Card-level $/solve vs the frontier anchor, every generation | If frontier prices collapse, "cheaper" dies and only "better than any single model" (capture >100%) still sells — which is why synthesis R&D is never deferred |
| Benchmark rankings predict customer results | P-C, quarterly | Presets demoted; calibration-as-a-service becomes the flagship (a pre-registered fork, not a crisis) |
| Acceptance signals honestly proxy quality | Correlate acceptance vs lab pass/fail on overlapping tasks | Re-weight the signals; never let a proxy headline a public claim |
| Gateways (OpenRouter/NotDiamond) stay out of fusion | Their product announcements | Speed and the A2 dataset are the only defenses; ship P1 quickly |
| The trust brand holds | Every published number replicates when checked | One inflated claim destroys A5 permanently — the pre-registration discipline is not optional, ever |

---

## 12. Artifact index

| Artifact | Path |
|---|---|
| This report | `docs/fusion/company-operating-system-2026-07.md` |
| Stage roadmap (P0–P3, market facts, margin math) | `docs/fusion/unicorn-roadmap-2026-07.md` |
| Model-freshness rethink + refresh pipeline stages 0′–4′ | `docs/fusion/strategy-rethink-2026-07.md` |
| Launch funnel this report repairs (§2) | `docs/fusion/oss-ensemble-launch-plan.md` |
| Living beliefs | `docs/fusion/capability-index-status.md` |
| Program history / decision log | `docs/fusion/capability-index-program.md` |
| Lab harness | `python/fusionkit-evals/` |
| Gateway (telemetry integration point) | `packages/cli/src/gateway.ts` |
