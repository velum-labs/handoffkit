# Ensemble Hypotheses v0 — public-data-only guidance for the first launch (2026-07)

**Status:** working guidance, drafted 2026-07-06. Deliberately *not* rigorous;
this is the cheap first pass that produces ensemble **hypotheses** from public
data alone, with zero billed benchmark runs. Real testing happens later, when
these hypotheses are run through FusionKit (the lab loop,
`lab-loop-2026-07.md`, is the rigorous successor that replaces this document
one cycle later).
**Reader:** whoever assembles the first panel configs.
**Core stance:** we are allowed to be un-rigorous about *how good* the
hypotheses are. We are not allowed to be un-rigorous about *what public data
can and cannot tell us* — that part we already measured (C2/C2V/OSS
rechecks), and this guidance is built directly on those results.

---

## 1. What we know about public data (the constraints this recipe obeys)

Three preregistered experiments (`analysis/phase0/`, `analysis/oss-rechecks/`)
tested whether public per-task outcome data can pick panels. The findings that
shape this recipe:

1. **Top-K-by-average is the unbeaten public-data pick.** Complementarity
   search (max oracle, or max expected-fused-value) never beat "take the top-K
   models by mean score" on held-out tasks on any product-relevant domain, and
   on SWE-bench Verified it was significantly *worse*. Consequence: **the
   backbone of every hypothesis is the public top-K, not a clever
   complementarity pick.** We do not run panel-selection optimizers over
   public matrices.
2. **Pairwise failure-correlation *signs* transfer** (C3: 10/10 mixed, 3/3
   OSS-only, public phi vs our calibrated phi). Consequence: public phi is
   usable as a **tiebreaker and veto**, never as a ranker.
3. **Lineage clones look diverse and fail together** (e.g. the two
   qwen3-235b-thinking variants, phi 0.702; deepseek-v3 siblings, phi 0.668).
   Consequence: **one model per base-family/teacher per panel**, always.
4. **Public dumps lag the frontier by 6–12 months** (D13). The current OSS
   generation (DeepSeek V4, Qwen 3.7, GLM-5.2, Kimi K2.7-code, MiniMax M3,
   Nemotron 3) has no per-task public data at all. Consequence: per-task
   matrices inform the *shape* of a good panel; the *members* come from
   current-generation aggregates and are provisional by construction.
5. **Some models are unmeasurable at default budgets** (seed audit: 2 of 3
   models truncation-invalid at 32k). Consequence: hypotheses must carry token
   budgets and an escalation rung, or the later FusionKit run wastes a cycle
   discovering this.

## 2. Answering the founder question directly: "just saturate the traditional benchmarks?"

Half yes, half no.

**Yes:** for v0 we skip our own task banks, skip Screen/Select/Confirm splits,
and anchor on public coding benchmarks. That is the right corner to cut first;
the split discipline only matters once *we* generate the numbers.

**No, with two corrections:**

- **"Traditional" must mean *unsaturated*.** MBPP/HumanEval are saturated
  (our own scan shows small 7–9B models at 60–76% with +22 pp panel
  headroom — that headroom is an artifact of weak models on easy tasks, and
  it is the one place complementarity selection "won," which is exactly why
  we distrust it). Anchor instead on benchmarks with live discrimination:
  **LiveCodeBench rolling windows** (algorithmic), **SWE-bench Pro**
  (repo bugfix; Verified is deprecated), **Aider polyglot** (edit-format
  competence), **Terminal-Bench** (agentic, with scaffold confounds noted).
- **"Aim to saturate" cannot mean "argmax union coverage."** Picking the
  panel whose members' public passes *union* to the highest benchmark
  coverage is exactly the oracle-argmax selection that C2 proved does not
  survive holdout — the union you see is fit to those specific public tasks.
  The honest version of the saturation intuition is structural: **cover
  different *failure styles* (reasoning-heavy, code-specialist, generalist,
  long-context) rather than different historical task IDs.**

## 3. The v0 recipe (all steps $0)

### Step 1 — Enumerate and shortlist (catalog + aggregates)

From the live provider catalog (OpenRouter + first-party APIs): all OSS
models updated in the last ~2 generations. Shortlist 8–12 by:

- vendor/leaderboard aggregate coding scores (LiveCodeBench leaderboard,
  Aider polyglot table, SWE-bench Pro leaderboard, Artificial
  Analysis-style aggregates) — *shortlisting is the validated use*;
- price band (we want at least one member ≤ $0.20/M input — the cascade
  fodder — and nothing above ~$4/M output);
- context ≥ 128k; provider stability (no beta-only hosting);
- declared or inferable lineage (base family + teacher), because Step 3
  needs it.

Keep 1–2 previous-generation bridge models (e.g. deepseek-v3.1-terminus)
— they link the new generation to our existing calibrated data.

### Step 2 — Build the backbone: top-K by aggregate, K ∈ {2,3}

Rank the shortlist by a simple mean of the available unsaturated-benchmark
aggregates (no weighting cleverness — it would be pseudo-rigor on top of
incomparable harnesses). The top-K under the constraints below is the
**backbone panel**. This is the C2 lesson applied: when in doubt, the
strongest members win; diversity is a tiebreaker, not an objective.

### Step 3 — Apply the four vetoes (hard constraints)

1. **Lineage veto:** one member per base family/teacher. Replace the
   violator with the next-ranked model from a different family.
2. **Truncation veto:** any model publicly known (or family-inferred) to
   need >32k thinking budgets gets an explicit 64k budget in the config —
   or is dropped if the price × 64k makes it uneconomical.
3. **Provider-identity pin:** every member is `model + provider + endpoint
   config`, written down. Same weights on a different provider = a
   different model until proven otherwise.
4. **Price sanity:** projected panel cost per request ≤ ~1/3 of the
   frontier anchor's cost per request (otherwise the eventual $/solve claim
   has no room even if quality lands).

### Step 4 — Diversify only among near-ties (the one soft rule)

Where two candidates sit within ~2–3 pp on aggregates (inside leaderboard
noise), prefer the one that:

- comes from a different lineage than the members already picked;
- has a lower public phi against them, **where any per-task data exists**
  (sign/tiebreak use only — validated by C3);
- has a different *style*: pair a reasoning model with a code-specialist
  with a fast generalist, rather than three of one kind.

This is the entire permitted amount of complementarity cleverness.

### Step 5 — Emit 3–5 named hypotheses, not one winner

Public data cannot rank panels, so we do not pretend to know which
hypothesis wins — we emit a small portfolio spanning the plausible shapes
and let FusionKit runs decide. The standard shapes:

| Shape | Construction | What it tests |
|---|---|---|
| **H1 backbone** | Top-K under vetoes, parallel + judge | The C2-honest default; the one to beat |
| **H2 style-diverse** | Backbone with near-tie swaps for style/lineage spread | Whether structural diversity buys real headroom |
| **H3 cheap-first cascade** | Cheapest competent member first; escalate to backbone on failure signals | The Pareto/product angle; most likely $/solve winner |
| **H4 best-single ×K** | Strongest member alone, K samples, exec-selection | The Self-MoA honesty baseline — *always shipped as a hypothesis, because if it wins the verdict is "route, don't fuse"* |
| **H5 thinking-heavy** (optional) | 2 reasoning models + 1 fast generalist, 64k budgets | Whether reasoning diversity dominates on hard tasks |

Judge: strongest instruction-following model available, **not required to
be a panel member**; one judge family across all hypotheses (fewer moving
parts).

### Step 6 — Write the hypothesis card (pre-registration lite)

One page per hypothesis, committed: members with pinned identities and
prices, topology, judge, token budgets, the *expected* result ("H2 beats
H1 by >2 pp or structural diversity is dead for this generation"), and
what evidence would kill it. This is not bureaucracy — it is what makes
the later FusionKit run cheap to interpret, and it is the seam where this
v0 process hardens into the lab loop's real preregistration.

## 4. Concrete v0 hypotheses (current generation, provisional)

Built from the 2026-06 catalog snapshot in `strategy-rethink-2026-07.md`
§2. **Aggregate scores for these models have not been verified in any
harness we control; every panel below is a hypothesis, not a
recommendation.** Prices are $/M in/out from the catalog snapshot.

Shortlist (one per family, bridge included): deepseek-v4-pro (0.43/0.87),
deepseek-v4-flash (0.09/0.18), qwen-3.7-plus (0.32/1.28), glm-5.2
(0.57/1.80), kimi-k2.7-code (0.74/3.50), minimax-m3 (0.30/1.20),
nemotron-3-super (~0.50/2.20), bridge: deepseek-v3.1-terminus (0.27/0.95).

| Hypothesis | Panel | Rationale |
|---|---|---|
| **H1 backbone** | deepseek-v4-pro + qwen-3.7-plus + glm-5.2 | Presumptive aggregate top-3, three distinct families |
| **H2 style-diverse** | deepseek-v4-pro + kimi-k2.7-code + qwen-3.7-plus | Swap generalist for the code-specialist: reasoning + code + generalist spread |
| **H3 cascade** | deepseek-v4-flash first → escalate to H1 | 30–80× price gap vs frontier is the product story; flash is cascade fodder by price |
| **H4 Self-MoA** | deepseek-v4-pro × 3 samples, exec-select | The baseline that must be beaten for any fusion claim |
| **H5 thinking-heavy** | deepseek-v4-pro + nemotron-3-super + minimax-m3, 64k budgets | Reasoning-diversity bet; carries the truncation-budget lesson |

Notes: deepseek-v4-pro and -flash share lineage — they never co-occupy a
panel (cascade escalation is sequential, not a panel, so H3 is legal).
Kimi K2.7-code inherits the K2 family's 64k-thinking flag until measured.
Judge candidate: qwen-3.7-max or the strongest member; decide at config
time, same family everywhere.

## 5. What this process does NOT claim

- It does **not** claim any hypothesis beats the best single model — H4
  exists precisely because it often does not.
- It does **not** rank H1–H5. Public data cannot do that (measured, three
  times). FusionKit runs will.
- It does **not** produce evidence cards, launch numbers, or anything
  publishable. Its outputs are configs + hypothesis cards only.
- It is **not** the process after cycle 1. Each rigor upgrade replaces a
  guess with a measurement: first the ~$25–50 calibration sweep (own
  per-task matrix, truncation audit), then split-validated selection, then
  the sealed-Confirm lab loop (`lab-loop-implementation-spec-2026-07.md`).

## 6. Failure modes we accept, and the one we don't

Accepted for v0 (cheap to fix later): wrong panel members (aggregates
mislead), wrong budgets (fixed after first sweep), missing a dark-horse
model (bridge + refresh catches it next cycle).

Not accepted: **shipping any claim from this stage.** The v0 hypotheses
exist to be *run*, not quoted. The first number anyone outside the team
sees comes from a FusionKit run on tasks we grade ourselves.
