# Ensemble & test-time-compute literature review (2026-07)

**Context:** written during the k=1 official-harness program
(`analysis/k1-swebench/`), after rounds 1/2B/2C/2A' produced a
route-don't-fuse verdict for the terminus+qwen3 panel and identified two
prompt-resistant commit-pipeline defects (judge abstention, synthesizer
non-compliance). This review maps the literature onto those findings and
onto FusionKit's design space. Companion: `MOA_DESIGN.md` (which
anticipated much of this structure), `k1-official-harness-plan-2026-07.md`.

## 1. The MoA lineage (single-turn text)

- **Mixture-of-Agents** (Wang et al., arXiv:2406.04692). Layered
  refinement: proposers generate; later layers see all previous outputs;
  final aggregator synthesizes. Beats GPT-4o on AlpacaEval 2.0 / MT-Bench /
  FLASK with open models. Key internal result (§3.3): the aggregator
  significantly outperforms an LLM-*ranker* — synthesis > selection — **on
  preference-judged single-turn text**. No tool calls, no agent loops, no
  execution grading anywhere.
- **Self-MoA** (Li et al., arXiv:2502.00674). Aggregating repeated samples
  of the *single best* model beats mixing different LLMs in most settings
  (+6.6 AlpacaEval over Mixed-MoA; +3.8 avg on MMLU/CRUX/MATH). Mechanism:
  a quality-diversity trade-off — "mixing different LLMs often lowers the
  average quality." Mixing helps only with genuinely complementary
  specialties. **Our 2A' result (terminus 67% + qwen3 40% fused to 60%) is
  a replication of this finding in the agentic regime.**
- **SMoA** (arXiv:2411.03284): sparsified agent communication (judge +
  early-stop moderator) for efficiency. **RMoA** (residual connections),
  **RouteMoA** (cheap pre-screening router): efficiency variants. None
  touch agentic/execution-graded settings.

## 2. Selection over finished artifacts (execution-graded regime)

- **DEI** (Zhang et al., arXiv:2408.07060, ICLR 2025). SWE-bench Lite:
  run N agents independently to completion; an LLM committee rates and
  re-ranks the finished patches. Best single 27.3% -> committee 34.3%
  (+25%). Winning groups were **peer-quality** (members 26-31%). Also
  validates the intra-agent variant (10 runs of one agent, re-ranked).
- **CodeMonkeys** (Ehrlich et al., arXiv:2501.14723). SWE-bench Verified:
  repeated sampling (candidate edits + model-written tests), then
  selection = **test-based voting filter + a dedicated selector trajectory
  that writes and runs tests to discriminate finalists**. 57.4% resolved
  vs 69.8% coverage (their selection gap). Their selector over an ensemble
  of leaderboard submissions: 66.2%, **beating the best member**.
- **LLM-Blender** (Jiang et al., ACL 2023). PairRanker (a *trained*
  pairwise ranker; beats zero-shot LLM ranking) + GenFuser (fuse only the
  top-K, cutting dead weight). Proto-precedent for "trained scorer >
  prompted judge" and "rank, then fuse survivors."

## 3. Step-level supervision for agents (2023-2026)

- **Let's Verify Step by Step** (Lightman et al., 2023). Process
  supervision beats outcome supervision for selecting among candidates.
- **SWE-PRM** (arXiv:2509.02360). Inference-time PRM monitors a SWE agent
  and injects **taxonomy-guided course-correction**: SWE-bench Verified
  40.0% -> 50.6% (+10.6pp) at ~$0.2/instance. Step-level intervention
  works — via structured feedback, not free-form judging.
- **SWE-TRACE** (arXiv:2604.14820). Multiple candidate actions per step;
  an **oracle/rubric verifier selects the best continuation** — explicit
  per-step action selection ("turns TTS from full-trajectory selection
  into step-level action selection").
- **SWE-Shepherd** (arXiv:2604.10493). Trained action-level PRMs for repo
  agents; notes difficulty aligning intermediate rewards with final
  success.
- **AgentProcessBench** (arXiv:2603.14465). Benchmark for step-level
  judgment in tool-using trajectories; finding: **models systematically
  struggle to separate neutral/exploratory steps from erroneous ones.**
  This independently names our judge's 54-66% abstention: mid-flight
  ambiguity is the epistemic situation, not a prompt bug — supporting
  "make abstention harmless" (`on_abstain: lead`) over "make the judge
  decisive" (our failed 2C v3).

## 4. Multi-model step-level search

- **AB-MCTS / Multi-LLM AB-MCTS / TreeQuest** (Inoue et al.,
  arXiv:2503.04412, NeurIPS 2025; already cited in `MOA_DESIGN.md`).
  Adaptive tree search deciding per node: go wider, go deeper, **and
  which model to call — learned online (Thompson sampling) from external
  feedback scores**. o4-mini + Gemini-2.5-Pro + R1 collectively beat each
  alone by ~30% on ARC-AGI-2. Closest published analogue to per-step
  multi-model fusion; its selector is a bandit over scores, not an LLM
  verdict.

## 5. Architecture search

- **Archon** (Saad-Falcon et al., ICML 2025). Generator / ranker / fuser /
  critic / verifier / unit-test components composed by Bayesian search
  per task+budget (+15.1% avg). Validates operators-as-config
  (CommitPolicy is one such axis) and `MOA_DESIGN.md`'s kernel framing;
  long-run: search the config space instead of hand-picking.

## 6. Condensed map

| granularity | aggregation | selector evidence | verdict |
|---|---|---|---|
| single-turn text | synthesis (MoA) | LLM preference | works; Self-MoA: quality > diversity |
| finished artifacts (SWE) | selection/re-rank (DEI, CodeMonkeys) | LLM committee; **executed tests** | works; beats best member; execution evidence is the strong form |
| per-step (SWE/agents) | course-correction (SWE-PRM), verifier selection (SWE-TRACE), bandit search (AB-MCTS) | taxonomies, rubrics, oracles, scores | works; nobody ships a free-form prompted judge |
| per-step (SWE) | zero-shot LLM judge + LLM synthesizer commit | judge prompt | **only this program — and it lost** (2A') |

**Through-line:** every winning system grounds its selector in something
harder than a zero-shot judge prompt — executed tests, votes, rubrics,
trained reward models, or online-learned scores.

## 7. Implications recorded for the program

1. **CommitPolicy (engine floor mechanics) stands**, independently
   reinforced: AgentProcessBench shows step ambiguity is intrinsic, so
   abstention must be made harmless mechanically.
2. **The judge's upgrade path is evidence, not prompts**: selection should
   see execution signal (CodeMonkeys-style test evidence in candidate
   trajectories; SWE-PRM-style rubric/taxonomy scoring). Design
   conversation for the product, beyond round 3's scope.
3. **Cheapest literature-predicted positive control**: DEI/CodeMonkeys
   artifact-level selection over the existing 2A' solo patches (~$0.10 of
   judge calls; ceiling = solo oracle, thin on this panel but validates
   the machinery).
4. **Panel guidance** converges from two directions: Self-MoA
   (quality-gapped mixing hurts) + DEI (peer-quality committees win) match
   this program's oss-scan peer-field rule and the observed qwen3 dead
   weight.
5. **Roadmap operators** for the lab-loop: PRM scorers as evidence
   sources, AB-MCTS as a scheduler, Archon-style search over operator
   configs — all consistent with `MOA_DESIGN.md`'s kernel architecture.
