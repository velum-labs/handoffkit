# Roadmap to a $1B company (2026-07)

**Status:** strategy roadmap, written 2026-07-06 after the founder discussion
that followed `strategy-rethink-2026-07.md`.
**Reader:** anyone deciding what the company (not just the ensemble program)
does next, and in what order.
**Relationship to other docs:** builds on the refresh pipeline
(`strategy-rethink-2026-07.md` §5) and the launch funnel
(`oss-ensemble-launch-plan.md`); supersedes neither. Program-level beliefs
stay in `capability-index-status.md`.

---

## 0. The thesis, one sentence

As models commoditize, durable margin moves to the layer that provably
converts cheap, diverse OSS intelligence into frontier-grade coding answers —
**proven statistically on dated, reproducible evidence cards, never promised
per-request**.

Explicit positioning boundary (founder decision, 2026-07-06): we do **not**
sell verified or guaranteed outcomes. Test execution is a *calibration-lab
instrument* (grading sweeps, measuring capture, producing evidence cards),
never a customer-facing contract. The claim is always about distributions
("X% at $Y/solve on benchmark B, dated"), never about a single request.
Rationale: test suites are incomplete oracles (OpenAI deprecated SWE-bench
Verified in 2026-02 after finding flawed tests in 59% of audited hard tasks;
independent audits put grading-infrastructure error near one-third of
verdicts), outcome-billing invites reward hacking by our own system, and
per-request guarantees convert a tool into an insurance contract.

## 1. Why the window exists (market facts, 2026)

| Fact | Source (checked 2026-07) | Implication |
|---|---|---|
| AI coding market ~$12.8B, +65% YoY; Cursor/Claude Code/Copilot each ≥$2B ARR | public market surveys / vendor disclosures | Demand is proven; distribution surfaces exist |
| Incumbents run at negative or thin gross margin; teams pay $200–600/dev/mo; vendors throttle | Cursor margin reporting; enterprise cost guides | A performance-per-dollar layer is the market's missing organ; incumbents are prospective *customers*, not just competitors |
| DeepSeek V4 Flash ~150x cheaper than GPT-5.5 output; OSS–frontier gap "narrow and not widening" | OpenRouter open-weights report 2026-06 | The input side of the arbitrage collapsed in our favor |
| OSS-only ensembles beat frontier models in the open literature (MoA, ICLR 2025; CTTS-MM 2025: +7pp over GPT-4.1) | published papers | The physics is validated and un-productized |
| SWE-bench Verified deprecated (contamination); trustworthy evals moved to private holdouts + telemetry | OpenAI deprecation notice 2026-02 | The eval vacuum is a business opportunity; our prereg/ledger/truncation discipline is a brand asset |
| OpenRouter at $1.3B on quality-neutral routing; NotDiamond does per-prompt *selection*; Martian pivoted away | funding announcements | Nobody occupies the fused-outcome layer; selection ≤ best member, fusion sells what's *above* it |

Unicorn math: $1B valuation ≈ **$50–100M ARR growing >100%** with real gross
margin, or control of an obviously strategic layer. The spread math supports
it: a cascade averaging ~3 flash-class calls + judge ≈ 5–12% of one frontier
call's cost; selling at 40–60% of frontier's effective $/solve leaves ~70%+
gross margin while undercutting incumbents who are at negative margin.

## 2. Corrections this roadmap locks in

1. **Benchmark retarget.** All public claims move off SWE-bench Verified
   (deprecated, contaminated) to: SWE-bench Pro (public split for iteration,
   held-out for claims), LiveCodeBench-style time-segmented tasks, and a
   private time-segmented holdout built from recent (<6 mo) commits.
2. **Mandatory baseline.** Every capture pilot includes
   *best-single-member × K samples at matched cost* (the Self-MoA baseline).
   If multi-model fusion cannot beat single-model best-of-N, the multi-model
   premise fails and we need to know at pilot cost, not launch cost.
3. **Pricing.** Usage-based on fused turns. $/solve lives in the evidence
   card as the reason to buy, never in the billing meter (no pay-per-green-
   build, no outcome SLAs — see §0).
4. **Telemetry from the first shipped turn.** Every production fused turn
   logs candidates, judge decision, and soft acceptance signals (patch kept,
   retry, session continued). Executable ground truth stays offline in the
   calibration lab. Retrofitting this later is 10x harder.

## 3. The roadmap

Stages are gated by evidence, not dates. Each stage lists: goal, the work,
the numbers that matter, the gate to advance, and the kill/pivot rule.

### Stage P0 — Prove the physics (now; ~$100–200 API + Step 4 engineering)

The current program plan, corrected. Nothing downstream matters until this
gate passes.

- **Work:** Step 4 repo-grading harness → refresh sweep on the current OSS
  generation (stages 0′–1′ of the refresh pipeline) → capture pilots
  (stage 2′) with the Self-MoA baseline → first evidence card on
  SWE-bench Pro held-out + private holdout.
- **Numbers:** truncation-valid rows; oracle headroom ≥ ~8pp; capture ≥ ~50%;
  fused vs best-member-×-K at matched cost; $/solve vs frontier anchor.
- **Gate:** one true sentence with CIs — "fused ensemble solves X% at
  $Y/solve; frontier anchor solves X′% at ~3Y" — on a contamination-resistant
  benchmark.
- **Kill rule:** fused never beats best-member-×-K after ~5 panel iterations
  → the thesis is routing-only; pivot or stop. Two failed panels on repo
  bugfix → wrong domain first, per the existing funnel.
- **Team:** ≤10. 2–3 calibration science, 3–4 fusion plane, 1–2 CLI/DX.

### Stage P1 — Wedge revenue ($1–10M ARR)

- **Product:** three surfaces, one backend —
  (a) `fusionkit fix` / `fusionkit <agent>` in a git repo (distribution/demo),
  (b) CI integration that attempts red builds (usage-priced; the user's own
  tests remain their acceptance check, exactly as with any coding agent),
  (c) `model: fusionkit/repo-bugfix` — an OpenAI-compatible fused endpoint
  any agent, IDE, or pipeline can call.
- **GTM:** 20–50 design partners from teams throttled by incumbent pricing.
  Sell with the evidence card; publish negative results ("don't fuse here,
  route to X") as trust features.
- **Numbers:** fused-turn volume, retention, $/solve trend, patch-acceptance
  rate (soft signal), capture rate per generation refresh.
- **Moat work:** refresh cadence live (~$30 sweep per OSS generation,
  ~3–4 months); judge/synthesizer versioned and evaluated against capture
  from day one; telemetry accumulating.
- **Gate:** organic pull on the endpoint (usage without hand-holding) and a
  second domain card (terminal/agentic) from the same funnel.

### Stage P2 — Platform turn ($10–50M ARR)

- **Products:**
  (a) the endpoint as the cheap-tier backend for agent companies and
  platforms squeezed on margin (the "Intel inside" play);
  (b) **private calibration-as-a-service** — C2 settled that public data
  cannot rank panels, and the same logic makes *each customer's codebase its
  own domain*: run the sweep on their repos, tune the panel, show measured
  numbers before commitment. No SLA attached — the customer's own acceptance
  rates are their proof. Priced on value of the method (~100x its API COGS).
- **Moat work:** judge/synthesizer training begins on accumulated
  cross-vendor candidate + acceptance data — the asset no lab can replicate
  without our traffic. Escalation/cascade policies (cheap model first,
  panel on uncertainty) learned from telemetry, cutting COGS per solve.
- **Category marketing:** quarterly "state of the ensembles" report from
  production telemetry + refreshed cards — the capability index becomes the
  reference others cite.
- **Gate:** net revenue retention >120%; gross margin ≥60% and rising with
  direct provider contracts.

### Stage P3 — Category ownership ($50–200M ARR → unicorn territory)

- Trained synthesizer delivers capture rates cold-start competitors cannot
  match; per-customer-tuned escalation policies raise switching costs.
- Direct OSS-provider contracts move gross margin toward ~80%.
- Second business line: capability-index data/API licensing (the Moody's
  model — the rating is the product).
- Optional M&A: an eval/holdout company to consolidate the trust layer; a
  sandbox-execution vendor for COGS.
- Strategic-acquirer interest (gateway, code-hosting, data-platform
  companies) sets the valuation floor; IPO path if the index line
  materializes.

## 4. Moats, in activation order

1. **Counter-positioning (now):** labs cannot sell cross-vendor ensembles;
   agent companies cannot fund a calibration-science org at negative margin;
   gateways will not take quality risk.
2. **Calibration authority (P0–P1):** dated, preregistered, reproducible
   cards refreshed every OSS generation, in a market that just lost its
   referee.
3. **Capture engineering (P1):** the oracle→capture gap is pure IP — judge
   protocols, cascade policies, fusion prompts. Configs copy; capture rates
   don't.
4. **Data flywheel (P2):** cross-vendor candidates × acceptance signals →
   trained synthesizer → higher capture → more traffic → more data.
5. **Switching costs (P2–P3):** private calibration makes the tuned panel
   load-bearing customer infrastructure.
6. **Buying power (P3):** volume pricing below gateway retail widens margin
   with scale.

## 5. What must be true (standing watch items)

| Assumption | Early-warning instrument | If it breaks |
|---|---|---|
| Fusion beats best-of-N at matched cost | P0 pilots (the next ~$200 decides) | Routing-only pivot or stop |
| Peer fields persist across OSS generations | Every refresh sweep re-measures field shape | Layer collapses to routing; index business survives |
| The OSS/frontier price spread survives | Card-level $/solve vs anchor each generation | Only >100% capture (synthesis manufacturing capability) still sells — hence synthesis R&D is never deferred |
| Gateways don't move up-stack into fusion | OpenRouter/NotDiamond product announcements | Speed + telemetry flywheel are the only defenses; ship P1 fast |
| Trust brand holds | Every published number replicates; negative results keep shipping | One inflated claim destroys the moat — prereg discipline is binding forever |

## 6. Immediate actions (already in flight or unblocked today)

1. Execute stages 0′–2′ of the refresh pipeline (`strategy-rethink-2026-07.md`
   §5) with the §2 corrections (Pro/holdout targets, Self-MoA baseline).
2. Step 4 repo-grading harness — still the launch bottleneck, still parallel.
3. Add acceptance-signal telemetry to the gateway before any public launch.
4. Version the judge/synthesizer config and record capture per version.
5. Record the §0 positioning boundary and §2 corrections as decisions in
   `capability-index-program.md` when the next round closes.
