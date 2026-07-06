# The Company Operating System — from evidence engine to great company (2026-07)

**Status:** full strategy report, written 2026-07-06 after the founder
discussions that followed `strategy-rethink-2026-07.md` and
`unicorn-roadmap-2026-07.md`.
**Reader:** anyone deciding what the company builds, measures, and refuses to
do — not just the ensemble program.
**Relationship to other docs:** operationalizes the roadmap
(`unicorn-roadmap-2026-07.md`); records the red-team of the domain playbook
(`oss-ensemble-launch-plan.md` §4–5) and its repair; supersedes the
"Card → CLI preset" expansion mechanic. Program beliefs stay in
`capability-index-status.md`; decisions proposed here (§10) land in
`capability-index-program.md` when adopted.

---

## 1. Thesis and positioning boundary

**The company** is the owner of the conversion layer between cheap model
diversity and delivered coding answers. "Owner" means: our **routing table**
decides route / fuse / escalate better than anyone else can, because two
proprietary loops feed it data nobody else has.

**Positioning boundary (founder decision, 2026-07-06):** we never sell
verified or guaranteed per-request outcomes. All claims are statistical
("X% at $Y/solve on benchmark B, dated, with CIs"), produced offline in the
calibration lab. Test execution is a lab grading instrument, never a
customer-facing contract. Rationale: test suites are incomplete oracles
(SWE-bench Verified deprecated 2026-02 after flawed tests were found in 59%
of audited hard tasks; independent audits put grading-infrastructure error
near one-third of verdicts); outcome-billing invites reward hacking by our
own system; per-request guarantees convert a tool into an insurance
contract.

**Pricing:** usage-based on fused turns. $/solve lives in evidence cards as
the reason to buy, never in the billing meter.

## 2. Red-team record: the domain playbook and its repair

The prior expansion mechanic was:

> Peer field? → Headroom? → Demand? → Gradeable? → Sweep → Pilot → Card →
> CLI preset

### 2.1 What the red team found

| # | Attack | Verdict |
|---|---|---|
| 1 | **Supply-driven ordering.** The rigorous gates are the physics gates; demand — the only revenue gate — is an unquantified judgment call placed third. The taxonomy is a benchmark taxonomy, not a purchase taxonomy (nobody has "a repo_bugfix-class task"; they have "my build is red") | Upheld — order inverted for domains #2+ (§2.2) |
| 2 | **"Domain" may not transfer.** The C2 logic (public data cannot rank panels) extends: a 60-task benchmark slice may not rank panels for a specific customer repo. If cards do not predict per-customer performance, presets are marketing and the pipeline is the product | Upheld — made a standing preregistered experiment (the Transfer Check, §7.3) |
| 3 | **The Gradeable gate fences us into the most commoditized battleground.** Mechanically gradeable domains are where benchmarks exist, contamination is worst, and every competitor optimizes | Upheld with mitigation — gate kept (honest cards require it); production acceptance signals admitted as a second-class evidence tier for domains the lab cannot grade |
| 4 | **Cards do not acquire customers; presets push classification onto the user.** The funnel ends at artifact production with no distribution step; a rack of per-domain presets asks users to diagnose their own task, which is our job (C3 already commits us to routing) | Upheld — one endpoint, presets demoted to aliases (§4 G1) |
| 5 | **One ensemble topology baked in.** Parallel fanout + judge synthesis fits single-artifact tasks; it fails structurally on long-horizon agentic work where candidates are divergent trajectories (headroom large, capture ~0). Alternatives exist with different economics: disagreement-triggered escalation, role-based ensembles (planner/coder/reviewer across vendors), best-single-model-×-K | Upheld — pilots become topology-aware (§4 G4) |

### 2.2 The repaired playbook

```
Domain #1 (now):  Peer? → Headroom? → Demand? → Gradeable? → Sweep
                  → topology-aware pilot → Card → ships inside THE endpoint
Domains #2+:      Observed demand (telemetry, partner asks)
                  → Gradeable-enough? → Peer+Headroom (as vetoes)
                  → Sweep → topology-aware pilot → Card → routing-table entry
Standing checks:  Transfer Check · Self-MoA baseline · route-don't-fuse
                  verdicts published in the Kill Ledger
Distribution:     never the card — the wedge surfaces (CI, endpoint inside
                  agents); cards are the answer to "prove it"
```

What survives untouched: calibration-first (settled by C2/C2V/OSS rechecks),
the gates as kill rules, staged rigor, and the playbook as-written for
domain #1.

## 3. The operating system: two loops, one asset

```
LAB LOOP (slow, rigorous, $30–500/cycle)      PRODUCTION LOOP (fast, noisy, ~free)
model generation released                      user invokes endpoint / CI / CLI
  → refresh sweep (truncation-audited)           → task fingerprinted
  → topology-aware pilot                         → routing table decides:
  → evidence card (dated, expiring)                 route | fuse | escalate
  → kill verdicts published                      → candidates + judge + acceptance logged
        │                                              │
        └────────────► THE ROUTING TABLE ◄─────────────┘
          per-task-class policy: which models, which topology,
          when to escalate — versioned, measurable, proprietary
```

- The **lab loop** produces trust and priors. It exists today: the refresh
  pipeline (`strategy-rethink-2026-07.md` §5), the `fusionkit-evals` harness,
  the `analysis/` round discipline.
- The **production loop** produces volume and ground truth about real work.
  It does not exist yet; §6 specifies it.
- **Neither loop is the product. The routing table is.** Cards are the lab
  loop's marketing exhaust; the endpoint is the production loop's front door.

## 4. Binding operating guidelines (G1–G10)

| # | Guideline | Enforcement |
|---|---|---|
| G1 | **One endpoint.** Domain presets are aliases into the routing table, never separate products. The user never classifies their own task | Product review gate on any new `fusionkit/<domain>` surface |
| G2 | **Demand nominates, physics vetoes.** After domain #1, expansion candidates come from telemetry and design-partner asks; peer/headroom/gradeable gates only kill, never propose | Expansion proposals must cite demand evidence first |
| G3 | **No un-instrumented turn, ever.** If the §6 telemetry schema is not populated, the turn does not ship | CI check on the gateway; schema version pinned |
| G4 | **Every pilot compares topologies, not just panels:** parallel fanout + synthesis; disagreement-triggered escalation; role-based (planner/coder/reviewer across vendors); best-single-member-×-K at matched cost (the Self-MoA baseline). "Route, don't fuse" is a shippable verdict | Preregistration template gains a mandatory topology section |
| G5 | **Every published number is preregistered, dated, and expires** one model generation (~4 months) after issue. Expired cards are pulled from marketing until re-swept | Card format carries `issued` / `expires` fields; marketing may not cite expired cards |
| G6 | **Never promise per-request correctness** (§1 boundary) | Contract/marketing review |
| G7 | **Publish the Kill Ledger.** Every gate failure becomes a public one-liner ("don't fuse X; use model Y") | Part of closing any analysis round |
| G8 | **The judge/synthesizer is versioned from day 0**; capture rate per judge version is a company-level KPI even while the judge is only a prompt | Judge config hash recorded per turn and per lab run |
| G9 | **The Transfer Check is a standing preregistered experiment** (§7.3). Its outcome decides preset-scaling vs calibration-as-a-service | Quarterly calendar entry; prereg before each run |
| G10 | **Rigor proportional to money at risk** (existing staged-rigor rule, unchanged) | Existing round discipline |

## 5. What compounds (A1–A6, ranked by terminal value)

| # | Asset | Why it compounds | Fed by |
|---|---|---|---|
| A1 | **The routing table** | Every lab cycle and every production turn makes its decisions measurably better; reconstruction requires both our history and our traffic | Both loops |
| A2 | **Cross-vendor outcome dataset** (candidates × judge decision × acceptance) | Unique by construction: labs see only their own outputs; gateways see traffic but no side-by-side candidates, no judge, no acceptance signal | Production loop |
| A3 | **The judge/synthesizer** | Capture rate is the visible quality edge; it rises with A2 and does not reset when panel members churn (members are inventory; the judge is an asset) | A2 + lab evals |
| A4 | **Calibration harness + refresh automation** | Cost-per-experiment falls every cycle; time-to-fresh (§8) becomes a velocity moat | Lab engineering |
| A5 | **Evidence-card corpus + Kill Ledger** | A multi-year archive of dated, replicable, expired-and-renewed claims cannot be faked retroactively by an entrant | Lab loop |
| A6 | **Per-customer calibration profiles** | Tuned panel + escalation policy becomes load-bearing customer CI infrastructure (switching cost) | Transfer Check + P2 service |

**Anti-assets (deliberately treated as perishable inventory):** panel
configs, model picks, individual cards, per-generation numbers. D13 already
established that anything model-specific depreciates in ~one generation.
Capital and attention go to A1–A6 only.

## 6. The data specification

### 6.1 Per production fused turn (the flywheel's fuel)

Logged by the gateway (`packages/cli/src/gateway.ts` /
`commands/ensemble-gateway.ts` path) for every turn, no exceptions (G3):

| Field group | Fields |
|---|---|
| Task fingerprint | repo language(s), repo size bucket, framework signals, prompt token count, inferred task class, task-class classifier version |
| Routing | routing-table version; decision (route / fuse / escalate); topology used; escalation trigger events (which uncertainty signal fired, when) |
| Per member | model + provider + endpoint version; input/output tokens; latency; cost; truncation flag; mid-stream failure flag |
| Candidates | all K candidate contents (content-addressed hashes + bodies); candidate order as presented to judge (anonymized, randomized per existing judge hygiene) |
| Judge | judge config hash (G8); decision; which candidate(s) contributed to the synthesis; synthesis body |
| Acceptance signals (value order) | (a) **edit distance between returned answer and what the user kept** (the gold signal — measured at next repo state or session end); (b) patch applied vs discarded; (c) retry within session; (d) session continued vs abandoned |
| Stamps | timestamp, panel generation stamp, session id, consent/privacy flags |

Privacy note: candidate/synthesis bodies are the sensitive rows; retention
and opt-out policy must ship with the first instrumented release, and the
schema must support hash-only mode for customers who refuse body retention.

### 6.2 Per lab run (existing discipline, made schema-explicit)

Preregistration doc; per-row outcomes with truncation flags; spend ledger
(JSONL, as in `analysis/seed-audit-32k/spend_ledger.jsonl`); oracle /
headroom / capture per topology; field-shape statistics; lineage vetoes;
generation stamp; judge version. Rounds stay immutable
(`capability-index-status.md` update protocol).

### 6.3 Derived company KPIs

| KPI | Definition | Why it is the number |
|---|---|---|
| **Capture rate per judge version** | (fused − best member) / (oracle − best member), on the lab slice, per judge config hash | Quality: the take-rate on the headroom market |
| **$/solve per task class** | total spend / tasks solved, lab and production views | Economics: the Pareto claim made concrete |
| **Time-to-fresh** | days from OSS model release → inclusion/exclusion verdict in the routing table | Velocity: the refresh moat, measurable |
| **Transfer coefficient** | rank correlation between card-level panel ranking and per-customer acceptance ranking (§7.3) | Strategy fork: presets vs service |
| **Routed-vs-fused mix** | fraction of turns where the table routes to a single model | Honesty: if this drifts toward 1, the fusion thesis is weakening and we want to see it first |
| **NRR / gross margin** | standard definitions | Business health; targets in `unicorn-roadmap-2026-07.md` (NRR >120%, GM ≥60% → ~80%) |

## 7. The proprietary pipelines (P-A … P-D)

### P-A · The Refresh Loop (exists as manual stages; automate)

Generation-triggered: OpenRouter catalog diff → shortlist with lineage veto
(`analysis/oss-scan/scripts/oss_scan.py` logic) → truncation-audited sweep
(the `seed_audit_runner.py` pattern generalized) → topology-aware pilots →
cards re-issued, expired cards pulled, routing table updated. Today this is
stages 0′–2′ of `strategy-rethink-2026-07.md` §5 run by hand at ~$30–70 per
cycle. **Target: time-to-fresh < 14 days with near-zero attention.** Known
engineering backlog item: mid-stream provider failure robustness (r1 had 10
JSON failures in the seed audit).

### P-B · The Flywheel Loop (does not exist; build after first traffic)

Nightly: production telemetry → acceptance-weighted evaluation of judge
versions and escalation policies → candidate improvements promoted through
lab evals before touching the routing table. Until A2 is large enough to
train on, the same loop tunes judge prompts and cascade thresholds. The day
the judge trains on production data and capture visibly exceeds the
prompt-only baseline is the day the company stops being copyable.

### P-C · The Transfer Check (standing experiment; preregister before first run)

Quarterly. Sample: all customers with ≥N accepted turns in the quarter
(N set in prereg). Compare: card-predicted panel ranking vs observed
per-customer acceptance ranking. Output: one rank-correlation number.
Decision rule (preregistered): sustained high transfer → scale presets;
sustained low transfer → cards become marketing only and
calibration-as-a-service becomes the P2 flagship. No middle-ground
narrative without a number.

### P-D · The Kill Ledger (pure discipline; start now)

Every gate failure becomes a published verdict with a date and a link to
the round. Zero engineering. Disproportionate trust yield in a market that
just lost its referee (SWE-bench Verified deprecation).

## 8. Benchmarking policy (post-Verified world)

Three evidence tiers, all three always reported:

1. **Private time-segmented holdout** — tasks from recent (<6 months)
   commits in licensed/partner repos; contamination-impossible by
   construction. The claim-bearing tier.
2. **Public contamination-resistant** — SWE-bench Pro (public split for
   iteration, held-out for claims) + LiveCodeBench rolling windows. The
   comparable tier. SWE-bench Verified is not cited in any public claim.
3. **Production telemetry** — acceptance rates, $/solve on real traffic.
   The ungameable tier; feeds the quarterly "state of the ensembles" note.

Non-negotiables carried over: preregistration before every run; per-row
truncation audit (>~10% truncated ⇒ number refused); spend ledgers; the
Self-MoA baseline in every pilot; judge anonymization + order randomization.

## 9. Sequencing (what to do, in order)

1. **Now (unchanged):** P0 of `unicorn-roadmap-2026-07.md` — Step 4
   repo-grading harness; fresh sweep (stages 0′–1′); topology-aware capture
   pilot (stage 2′ + G4). In parallel, two cheap-now/impossible-later items:
   implement the §6.1 telemetry schema in the gateway, and version the
   judge (G8).
2. **First card passes:** ship the one endpoint + CI wedge to design
   partners; telemetry accrues A2 from turn one; Kill Ledger goes public
   with the Phase-0/OSS-recheck negative results already in hand.
3. **First telemetry quarter:** first Transfer Check; demand data nominates
   domain #2 (G2); first "state of the ensembles" note.
4. **First judge trained on production data (P-B):** capture above
   prompt-only baseline → the moat event.
5. **Every OSS generation thereafter:** P-A turns the crank; cards renew;
   the table gets smarter; time-to-fresh gets shorter. Greatness is the
   slope of four curves — capture, $/solve, time-to-fresh, NRR — and every
   guideline exists to protect one of them.

## 10. Decisions proposed for the program log (when adopted)

| Proposed | Content |
|---|---|
| D15 | Positioning boundary: statistical claims only; no per-request verification promises; usage pricing (§1) |
| D16 | Benchmark retarget: SWE-bench Verified retired from public claims; three-tier evidence policy (§8) |
| D17 | Playbook repair: demand-first expansion after domain #1; one endpoint; topology-aware pilots; Self-MoA baseline mandatory (§2.2, G1–G4) |
| D18 | Telemetry mandate: §6.1 schema required before any public traffic (G3); Transfer Check standing (G9) |
| D19 | Card expiry: evidence cards carry expiry one generation after issue; expired cards pulled from marketing (G5) |

## 11. Risks and standing watch items

| Assumption | Instrument | If it breaks |
|---|---|---|
| Fusion beats best-member-×-K at matched cost | P0 pilots (the next ~$200 decides) | Routing-only pivot; A1/A4/A5 still have value; A2/A3 do not |
| Peer fields persist across generations | Every P-A sweep re-measures field shape | Layer collapses to routing; index/eval business survives |
| OSS/frontier price spread survives | Card-level $/solve vs anchor per generation | Only >100% capture still sells → synthesis R&D is never deferred |
| Cards transfer to customers | P-C, quarterly | Presets → service pivot (preregistered fork, not a crisis) |
| Acceptance signals are honest proxies | Correlate acceptance vs lab pass on overlapping tasks | Re-weight signals; never let a proxy headline a claim |
| Gateways move up-stack into fusion | Product announcements (OpenRouter/NotDiamond) | Speed + A2 flywheel are the only defenses; ship P1 fast |
| Trust brand holds | Every published number replicates | One inflated claim destroys A5 — prereg discipline is permanent |

## 12. Artifact index

| Artifact | Path |
|---|---|
| This report | `docs/fusion/company-operating-system-2026-07.md` |
| Stage roadmap (P0–P3, market facts) | `docs/fusion/unicorn-roadmap-2026-07.md` |
| Model-freshness rethink + refresh pipeline | `docs/fusion/strategy-rethink-2026-07.md` |
| Launch funnel being repaired (§2) | `docs/fusion/oss-ensemble-launch-plan.md` |
| Living beliefs | `docs/fusion/capability-index-status.md` |
| Program history / decision log | `docs/fusion/capability-index-program.md` |
| Lab harness | `python/fusionkit-evals/` |
| Gateway (telemetry integration point) | `packages/cli/src/gateway.ts` |
