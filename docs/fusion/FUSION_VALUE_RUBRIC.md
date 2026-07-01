# Fusion Value Rubric

**The question this rubric answers:** when an engineer runs `fusionkit codex`
(or `claude` / `cursor` / `serve`), is the ensemble *actually worth it* — does
it measurably lift performance over the best single panel member, at a cost
and latency the user would accept — and is that lift trustworthy, repeatable,
and durable as models change?

DX and out-of-the-box polish are tracked elsewhere. This rubric is only about
**fusion value**: quality, cost, reliability, measurement integrity, and the
capacity to keep winning. It is the fixed yardstick for the production audit
and the roadmap derived from it. Every criterion is executable against
machinery that exists in this repo (`fusionkit-evals`, the kernel replay
records, the gateway cost meter); none of it is aspirational hand-waving.

Anchors from the reference systems are cited per dimension:

- **OpenRouter Fusion** — single-layer panel → comparing judge (structured
  JSON) → grounded final answer; the *outer model decides* when to fuse;
  bounded recursion; ~2–3× latency only when invoked.
- **Together Mixture-of-Agents** — layered proposer/aggregator refinement;
  "collaborativeness" (models improve after seeing other models' outputs).
- **Devin Fusion (Cognition)** — frontier quality at 35–41% lower cost via a
  sidekick agent, persistent cached contexts, routing decisions taken at
  context-compaction time; writes stay single-threaded; extra agents
  contribute *intelligence, not actions*.
- **Sakana Fugu** — a *trained* orchestrator (Trinity selection head /
  Conductor RL) over a worker pool; intra-workflow agent isolation to prevent
  orchestration collapse; persistent shared memory across workflows;
  coordinators retrained as the model pool changes.

---

## 0. Definitions and standing rules

- **Compound** — the fused output of the full pipeline as shipped (panel →
  judge → synthesizer, with whatever routing/selection policy is default).
- **Best single** — the strongest individual panel member run through the
  *same harness on the same tasks in the same run* (apples-to-apples, as in
  `fusion_compound.compare_compound_vs_individual`). Never a leaderboard
  number from someone else's harness.
- **Oracle** — per-task best candidate (upper bound of selection-only fusion).
- **Regret** — `oracle_success − synthesized_success`
  (`judge_synthesis_regret` in `fusion_bench.py`): how much of the achievable
  ensemble value the judge+synthesizer stage throws away.
- **Held-out** — tasks flagged `holdout: true` (or post-cutoff time windows
  for LiveCodeBench) that were never used for prompt tuning, hill-climbing,
  router training, or panel selection. Hill-climb (`fusion_hillclimb.py`)
  optimizes on dev; the rubric scores **only** on held-out.
- **Significance** — paired McNemar test (`prompt_tuning.mcnemar`) at
  p < 0.05, plus Wilson intervals on rates. Uplift without significance
  scores as "no evidence", not partial credit.
- **No corner-cutting rule** — a criterion is met only when the evidence is a
  reproducible artifact (bench report JSON + config + git SHA + seed), not a
  one-off terminal paste. Synthetic fixtures (`smoke_only`,
  `public_claim_eligible: false`) never satisfy any criterion.

### Scoring

Each criterion scores **0 / 1 / 2**:

- **0 — Absent**: not implemented or not measured.
- **1 — Present**: implemented and measured at least once with a real run;
  below threshold or not yet wired into the default `fusionkit codex` path.
- **2 — Met**: threshold met on held-out data, on the default path, with a
  reproducible artifact.

Dimensions have weights (in brackets). The audit produces a weighted score
per dimension and overall. Independently of the score, the four **hard
gates** (§10) decide "production" — a high score cannot compensate for a
failed gate.

---

## 1. Headline uplift — does the compound beat the best single? [weight 20]

The reason to exist. Everything else serves this.

| # | Criterion | Threshold for "Met" |
|---|---|---|
| 1.1 | **Held-out coding uplift, primary benchmark.** Compound vs best single on ≥1 public agentic coding benchmark run through the real `fusionkit codex` gateway (SWE-bench-class, Terminal-Bench, or Aider polyglot via `public_bench.py` adapters). | Uplift > 0 with McNemar p < 0.05; ≥ 200 paired tasks or the full official suite. |
| 1.2 | **Replication on a second benchmark family.** Same result on a second, structurally different benchmark (e.g. LiveCodeBench post-cutoff window if 1.1 was SWE-bench-class). | Uplift > 0, p < 0.05. |
| 1.3 | **Uplift magnitude.** The lift is worth the complexity. | ≥ +3 points absolute pass-rate over best single on at least one of 1.1/1.2 (Fugu-class ambition is +5–10; OpenRouter claims "beyond frontier"). |
| 1.4 | **Never-worse floor.** The compound is not significantly *worse* than best single on any measured benchmark or task class. | No benchmark/class where best single beats compound at p < 0.05. |
| 1.5 | **Variance honesty.** Multi-seed runs (`bench_stats` seed aggregation) with CIs reported; uplift survives across seeds. | ≥ 3 seeds where the harness is stochastic; uplift CI excludes 0. |
| 1.6 | **Non-coding sanity check.** At least one measured non-coding suite (chat/reasoning) so coding gains are not paid for with silent regressions elsewhere the router might send traffic. | Measured once; no significant regression. |

*Anchor:* Fugu's model card reports per-benchmark wins over every worker in
its pool; OpenRouter published a "fusion beats frontier" eval before shipping
the alias. Neither shipped on vibes. Currently this repo has the machinery
but only synthetic fixtures — dimension 1 is the single biggest gap.

## 2. Ensemble headroom — is there anything to fuse? [weight 10]

If the panel's errors are correlated, no judge can help. These are the
diagnostics that tell you *where* value lives before you spend on
judge/synthesis work.

| # | Criterion | Threshold |
|---|---|---|
| 2.1 | **Oracle gap.** `oracle_success − best_single_success` on held-out coding tasks — the value ceiling of selection. | Measured and reported per benchmark; ceiling ≥ +5 points (else re-design the panel, not the judge). |
| 2.2 | **Failure decorrelation.** Pairwise failure correlation (`fusion_bench._failure_correlations`) across panel members. | Reported per pair; panel chosen so no pair exceeds ~0.7 on the target task class; decorrelation feeds panel selection, not just a report. |
| 2.3 | **Marginal member value.** Ablation: compound with N vs N−1 members (leave-one-out). Each member must pay for itself. | Every default-panel member contributes ≥ +1 point or is documented as a resilience/failover member. |
| 2.4 | **Diversity source coverage.** Panel spans ≥ 2 independent model families by default (already true: GPT + Claude + Gemini), and the config surface makes swapping members trivial when the pool shifts. | True by default; ablation data justifies the specific trio. |
| 2.5 | **Self-consistency baseline.** `self` mode (same model, temperature-varied) measured against the multi-model panel — the cheap alternative that must be beaten to justify multi-vendor cost. | Panel beats self-mode at matched sample count, p < 0.05, on coding. |

*Anchor:* MoA's core finding is that diversity drives the effect; Fugu's
whole training signal is per-worker success distributions. 2.1/2.2 are the
same idea, measured instead of learned.

## 3. Judge quality — is selection intelligence real? [weight 12]

The judge is the first place ensemble value dies. It must be measured as a
classifier, not trusted as an oracle.

| # | Criterion | Threshold |
|---|---|---|
| 3.1 | **Judge selection accuracy.** When candidates differ in correctness, how often does `best_trajectory` name a correct one? Measured on tasks with ground truth. | ≥ 70% top-1 accuracy where exactly one candidate is correct; reported per task class. |
| 3.2 | **Regret decomposition.** Split total regret into *judge regret* (picked wrong candidate) vs *synthesis regret* (picked right, ruined it in rewrite). The repo computes total regret; the audit needs the split. | Split computed on every bench run; each component < 5 points. |
| 3.3 | **Structured-output reliability.** Judge JSON parse failure rate; behavior on failure. Today a parse failure degrades to a sentinel analysis that the synthesizer silently consumes. | Parse failure < 1% via JSON-mode/constrained decoding + one retry; failures surfaced in trace events, never silent. |
| 3.4 | **Judge calibration.** Judge confidence (consensus size, best-trajectory margin) correlates with actual correctness; enables downstream policies (e.g. "low confidence → select-best, don't rewrite"). | Calibration curve produced; monotone relationship demonstrated. |
| 3.5 | **Judge cost/model tiering.** Judge model choice justified by ablation (frontier judge vs cheap judge) — the judge is a per-turn cost multiplier. | Ablation exists; default documented from data. |
| 3.6 | **Comparing, not merging.** Judge output stays structured analysis (consensus/contradictions/unique insights/likely errors), preserved into the synthesizer prompt; no lossy summarization of candidates. | True today (`FusionAnalysis`); keep under regression test. |

*Anchor:* OpenRouter's judge "compares rather than merges" and treats
consensus as higher-confidence — same schema as `FusionAnalysis`. The gap is
that OpenRouter validated the judge; here 3.1–3.4 are unmeasured.

## 4. Synthesis policy — rewrite, select, or ground? [weight 12]

For code, the literature and this repo's own `exec_select.py` docstring agree:
execution-grounded *selection* is the SOTA paradigm, and free-form rewriting
of code from multiple candidates is regression-prone. Today the default is an
LLM rewrite and `synthesis_select_best` is opt-in — the default disagrees
with the stated belief.

| # | Criterion | Threshold |
|---|---|---|
| 4.1 | **Synthesis-vs-selection ablation.** On held-out coding tasks: LLM-rewrite vs judge-pick-verbatim vs execution-guided selection, same panel. | Ablation run; the *winning* policy is the default per task class. |
| 4.2 | **Synthesis regression rate.** Fraction of tasks where the synthesized output is worse than the judge-selected candidate. | < 5% on coding; if higher, rewrite must be off the default code path. |
| 4.3 | **Execution grounding on the live path.** Public-test / build / lint signals (leakage-free, à la `exec_select.py`) wired into the *gateway* fusion decision for coding turns — not only the eval harness. | Available and default-on for `fusionkit codex` where the repo has runnable checks; leakage rules enforced (selection sees public signals only). |
| 4.4 | **Trajectory-aware synthesis.** The synthesizer consumes candidate *trajectories* (reasoning, tool calls, tool outputs — already the `Trajectory` unit), not just final texts, and demonstrably uses them (ablation: items vs content-only). | Ablation shows trajectory items add ≥ +1 point or they are trimmed for cost. |
| 4.5 | **Single-writer discipline.** Fused output that edits code comes from one writer; panel candidates contribute intelligence (analysis, diffs-as-evidence), never concurrent writes to the user's tree. Worktree isolation already enforces this — keep it gated by test. | Invariant holds; regression-tested. |
| 4.6 | **Attribution/provenance.** Fused answer records which candidate(s) contributed (`selected_trajectory_id`, rationale, metrics on `TrajectorySynthesis`) so wins/losses are debuggable per model. | True today; keep, and surface in scope dashboard. |

*Anchor:* Devin's production doctrine — "writes stay single-threaded;
additional agents contribute intelligence rather than actions" — is 4.5.
Fugu-Ultra's verifier roles are 4.3 generalized.

## 5. Routing & adaptivity — fuse when it pays [weight 12]

Always-fuse burns money on easy turns; never-fuse forfeits the product. The
router is where Fugu and Devin both put their learning first.

| # | Criterion | Threshold |
|---|---|---|
| 5.1 | **Router evaluated against both trivial policies.** Router vs always-fuse vs never-fuse (best single) on held-out mixed workloads: quality, cost, latency. | Router ≥ always-fuse quality − 1 point at ≤ 60% of its cost, and > never-fuse quality at p < 0.05. |
| 5.2 | **Beyond keyword heuristics.** Replace/augment `HeuristicRouter` (keyword + length) with a learned or calibrated policy (even a small classifier over embeddings) trained on this system's own outcome records. | Learned router deployed behind a flag; beats heuristic on 5.1's frontier. |
| 5.3 | **Escalation (model-decides) mode.** An OpenRouter-style path where the primary model can *invoke* fusion as a tool mid-task instead of a priori routing; recursion bounded (depth guard). | Implemented with depth bound; measured vs a-priori routing. |
| 5.4 | **Difficulty-adaptive depth.** Panel size / sample count / (later) layers scale with estimated difficulty rather than fixed `sample_count: 4`. | At least two depth tiers driven by router signal; cost-quality frontier reported. |
| 5.5 | **Mid-session adaptivity.** Routing decisions can change *within* a session at natural boundaries (turn end; later, compaction), so a session that turns hard gets fusion and a session that turns easy sheds it. | Per-turn routing live; decision logged per turn in trace. |
| 5.6 | **Cost-aware objective.** Router optimizes quality-per-dollar, not just quality — the Devin framing (frontier quality at −35% cost) is a first-class product mode next to the "beyond-frontier" mode. | Both modes exist as named presets with measured frontiers. |

*Anchor:* Fugu's `fugu` variant is exactly 5.2 taken to the limit (a trained
selection head); Devin's compaction-time switching is 5.5 plus cache
economics (§7). The kernel's `OutcomeRecord`/replay stream is the training
data for 5.2 and nothing consumes it yet.

## 6. Agentic/trajectory fusion mechanics — the `fusionkit codex` specifics [weight 10]

Chat fusion and coding-agent fusion are different problems. These criteria
cover the harness-gateway path specifically.

| # | Criterion | Threshold |
|---|---|---|
| 6.1 | **Candidate freshness.** Panel candidates are produced per user turn and cached per turn (current design); staleness across a long tool loop is bounded and measured — fusing against candidates from an outdated repo state must not degrade later turns. | Staleness policy documented; ablation shows no degradation ≥ 3 tool-rounds deep; TTL/invalidations tested. |
| 6.2 | **Tool-call fidelity through fusion.** Fused steps emit tool calls that are schema-valid for the harness dialect ≥ 99.9% (Responses / Messages / Chat); malformed-call rate tracked in trace. | Measured on real harness runs; < 0.1%. |
| 6.3 | **Panel isolation vs shared memory.** Panel members run isolated (own worktrees — prevents orchestration collapse, per Fugu-Ultra), while the fusion step sees the *live* conversation including prior tool results (shared memory across turns). Both invariants regression-tested. | True today by construction; tests pin it. |
| 6.4 | **Full-trajectory judging.** The judge sees candidates' tool calls and outcomes (not just final diffs/text), truncation limits (`prompts._truncate`) tuned by ablation rather than fixed 1200/600-char guesses. | Truncation ablation done; limits set from data. |
| 6.5 | **Multi-turn compounding.** Uplift measured on *multi-turn* agentic tasks end-to-end (not just single-shot), since per-turn wins can wash out over a session. | ≥ 1 multi-turn benchmark (Terminal-Bench-class) in the §1 evidence. |
| 6.6 | **Failover value.** Rate-limit/credit handoff (passthrough → ensemble) preserves session continuity and its quality cost is measured (fused turn vs the vendor turn it replaced). | Handoff quality delta reported; no session corruption in soak tests. |

## 7. Cost & latency economics [weight 10]

A quality win the user turns off is not a win.

| # | Criterion | Threshold |
|---|---|---|
| 7.1 | **Cost per solved task.** Reported next to pass rate on every bench run (Pareto points exist in `fusion_bench`); compound vs best single. | Compound cost-per-solve ≤ 2.5× best single in beyond-frontier mode; ≤ 1.0× in the cost-preserving mode (5.6). |
| 7.2 | **Latency budget.** p50/p95 added latency of fused turns vs single-model turns, measured at the gateway; streaming starts within an acceptable bound (synthesis streams; panel is the blocking stage). | p95 fused-turn overhead ≤ 2.5× single (OpenRouter's own bar is 2–3× *when invoked*); overhead attributed per stage in trace. |
| 7.3 | **Straggler policy.** Panel fan-out has hedging: soft timeout, early-cancel of stragglers once quorum is reached, configurable quorum size. | Implemented; p95 latency improves measurably with no significant quality loss. |
| 7.4 | **Prompt caching.** Provider prompt caching (`cache_control` / cached prefixes) on panel, judge, and synthesizer calls; cache hit rates metered. Today absent — every judge/synth call re-sends the conversation uncached, multiplying the ensemble tax. | Implemented for Anthropic + OpenAI paths; measured ≥ 50% input-token cost reduction on multi-turn sessions. |
| 7.5 | **Budget enforcement honesty.** `--budget` caps enforced pre-spend (refuse the turn) not just post-hoc accounting; per-stage (panel/judge/synth) spend visible per turn. | Pre-spend gate tested; per-stage breakdown in session cost lines. |
| 7.6 | **Token efficiency of fusion prompts.** Judge/synth prompt overhead (candidate serialization) tracked per turn; trimming policies ablated (ties into 6.4). | Overhead reported; no unbounded growth with session length. |

*Anchor:* Devin Fusion is entirely this dimension — its innovation is making
multi-model economics *free* (cache-aligned switching). 7.4 is the
prerequisite for ever matching that.

## 8. Reliability of the fusion path [weight 6]

| # | Criterion | Threshold |
|---|---|---|
| 8.1 | **Partial-panel degradation.** Failed members become failed trajectories; fusion continues with survivors; quality-with-N−1 measured (ties to 2.3). Already implemented — needs the measurement. | Soak-tested with injected provider failures; behavior + quality delta documented. |
| 8.2 | **All-fail and judge-fail behavior.** `PanelExhaustedError` and judge/synth provider failure produce a defined, user-visible fallback (e.g. degrade to best-available single model), never a hang or silent junk. | Fallback policy implemented + chaos-tested. |
| 8.3 | **Determinism & replay.** Any fused turn reproducible from replay records (`fusion-runtime-replay.v1`, wire captures) for debugging regressions; streaming envelope caveat documented. | A failed benchmark task can be replayed offline end-to-end. |
| 8.4 | **Version-drift resilience.** Provider model deprecations/renames (the pool *will* shift) fail loud with actionable errors; panel presets versioned so a model retirement doesn't brick default configs. | Preset update process documented + tested against a renamed model. |
| 8.5 | **Concurrency safety.** Parallel sessions / parallel turns don't cross-contaminate candidate caches or worktrees. | Concurrency soak test in CI. |

## 9. Measurement integrity & the self-improvement loop [weight 8]

The moat is not this month's uplift; it's the loop that keeps producing
uplift as the pool changes. Fugu explicitly retrains coordinators when new
models arrive — the equivalent here must be operational, not manual heroics.

| # | Criterion | Threshold |
|---|---|---|
| 9.1 | **Locked holdout discipline.** Dev/holdout split enforced by tooling (tuning jobs physically can't read holdout); LCB contamination windows respected. | Enforced in code, not convention. |
| 9.2 | **Continuous bench harness.** The §1 benchmark suite runs on a schedule / per release against the real gateway; results land as versioned artifacts with config + SHA + seeds. | Operational; ≥ 2 historical runs comparable. |
| 9.3 | **Hill-climb loop proven.** `fusion_hillclimb` (prompts → config → gated source changes) has produced at least one significant held-out improvement end-to-end. | One documented win with before/after artifacts. |
| 9.4 | **Outcome records feed learning.** Kernel `OutcomeRecord`/replay streams are collected and consumed by at least one learned component (router 5.2 is the natural first). | Data pipeline exists; first consumer trained from it. |
| 9.5 | **Pool-refresh playbook.** When a new frontier model ships: add to panel → decorrelation + leave-one-out (§2) → re-tune prompts on dev → re-verify §1 gates on holdout. Documented, semi-automated, exercised once. | Exercised on a real model addition. |
| 9.6 | **Honest public claims.** Any published number satisfies `public_claim_eligible`; disclaimers separate same-harness comparisons from leaderboard comparisons. Machinery exists — keep it binding. | Enforced in report generation. |
| 9.7 | **Per-dimension dashboards.** Regret split (3.2), router frontier (5.1), cost/latency (7.1–7.2) visible in scope so regressions are seen between bench runs. | Live in scope dashboard. |

## 10. Architecture headroom — can we keep up with the frontier of fusion? [weight 4]

Deliberately low weight: the kernel review already established the
abstraction is sound. These criteria stop scaffolds from rotting.

| # | Criterion | Threshold |
|---|---|---|
| 10.1 | **One runtime, not two.** Python `FusionEngine` behavior expressible as kernel graphs (kernel-migration seam completed) so TS kernel and Python engine can't drift. | Default gateway flow runs through registered kernel workflows end-to-end. |
| 10.2 | **Next patterns behind flags, benchable.** Multi-layer MoA and execution-select-repair runnable via workflow IDs against the bench harness (not just unit-tested graph shapes), so §1 machinery can evaluate them the day they matter. | Both runnable in `fusion-bench` with one config switch. |
| 10.3 | **Scheduler seam proven.** One non-trivial adaptive scheduler (e.g. quorum/hedging from 7.3, or learned router 5.2) shipped through the `Scheduler` seam without kernel changes — evidence the extension point is real. | Shipped once. |
| 10.4 | **Learned-orchestration runway.** A written design (not code) for how outcome/replay data would train a Fugu-style policy (selection head first), including what's logged today vs missing. | Design doc exists; logging gaps closed. |

---

## Hard production gates

Independent of weighted score, **production = all four gates pass**:

- **Gate A — Proven uplift.** Criteria 1.1 *and* 1.2 at level 2, with 1.4
  (never-worse) holding. No gate-A, no headline claim, no launch.
- **Gate B — Explained uplift.** Regret split (3.2) and oracle gap (2.1)
  measured, and the chosen default synthesis policy (4.1) is the empirical
  winner for code. This is the "not cutting corners" gate: we know *why* we
  win, so we can keep winning.
- **Gate C — Acceptable economics.** 7.1 and 7.2 within thresholds on the
  default path, and at least one of {7.3 hedging, 7.4 caching} shipped.
- **Gate D — Trustworthy loop.** 9.1 (locked holdout), 9.2 (repeatable
  bench), 9.6 (honest claims) all at level 2.

## Audit protocol (how this rubric gets applied)

1. **Instrument first.** Close measurement gaps that block scoring (regret
   split 3.2, judge accuracy 3.1, per-stage latency 7.2) — small eval-code
   changes, no product changes.
2. **Baseline run.** One full real benchmark run (1.1) with the current
   defaults, multi-seed where affordable. Score every criterion 0/1/2 from
   artifacts; unknown = 0.
3. **Ablation battery.** 2.1–2.5, 3.5, 4.1–4.2, 5.1 from the same run's
   captured candidates where possible (selection ablations replay cheaply;
   only re-synthesis costs new tokens).
4. **Gap ranking.** Expected-uplift-per-effort ordering of failed criteria;
   this becomes the roadmap. Standing prediction from the architecture
   review: 4.3 (execution grounding on the live path), 7.4 (caching),
   5.2 (learned router), 3.3 (judge JSON hardening) will top the list.
5. **Re-run and lock.** After each roadmap tranche, re-run §1 on holdout;
   a tranche ships only if Gate A metrics did not regress.

## Scoring sheet (fill during audit)

| Dim | Weight | Criteria met (2) / present (1) / absent (0) | Weighted |
|---|---|---|---|
| 1. Headline uplift | 20 | — | — |
| 2. Ensemble headroom | 10 | — | — |
| 3. Judge quality | 12 | — | — |
| 4. Synthesis policy | 12 | — | — |
| 5. Routing & adaptivity | 12 | — | — |
| 6. Agentic mechanics | 10 | — | — |
| 7. Cost & latency | 10 | — | — |
| 8. Reliability | 6 | — | — |
| 9. Measurement & loop | 8 | — | — |
| 10. Architecture headroom | 4 | — | — |
| **Total** | **104** | | |

Gates: A ☐ B ☐ C ☐ D ☐
