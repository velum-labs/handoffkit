# k=1 Official-Harness Experiment Plan

**Status:** adopted 2026-07-06 (experiment branch
`cursor/k1-official-harness-experiments-e24a`, on top of the capability-index
work)
**Audience:** program contributors; assumes the vocabulary below and nothing
else.
**Relationship to prior work:** this plan does not replace the funnel in
`oss-ensemble-launch-plan.md`; it adds the measurement the funnel is missing —
step-level fusion, the regime the shipped product actually runs in — and
removes a confound the prior rounds accepted (the custom calibration harness).

---

## 1. Vocabulary (binding for this branch)

The program's documents have overloaded these terms; on this branch they mean
exactly one thing each:

- **N** — panel size: the number of distinct models that propose on each
  step. (Previously written "K" in `oss-ensemble-launch-plan.md` §2.)
- **k** — step budget per panel member before aggregation: the CLI `--k`
  flag (main, commit `4bb4df3`). **k=1** means each member produces a single
  completion proposing its immediate next step (one tool-call batch or a
  final answer), and fusion commits exactly one proposal per step.
- **Harness** — always qualified:
  - *benchmark harness*: the runner/scaffold/grader distributed by or
    endorsed by the benchmark itself;
  - *calibration harness*: our internal `fusionkit-evals` pipeline
    (candidate bank + local sandbox grading), **not used in this plan**;
  - *coding harness*: an interactive agent tool (Codex, Claude Code,
    Cursor) — the product surface, not an evaluation instrument.

## 2. What this fixes (the epistemological problems)

The evidence base as of Phase 0 / oss-scan / thinking-32k has three gaps this
plan closes:

1. **Regime gap.** Every capture number so far is single-shot,
   terminal-answer, no-tools fusion — the *no-tools special case* of the
   engine. The product's flagship path is step-level fusion (k=1) where the
   judge ranks *proposals* whose value depends on unobserved future
   consequences, and where all members share the committed prefix (the
   independent-trajectory diversity that produced the measured +10–20pp
   headroom may not survive prefix-sharing — or may compound favorably via
   per-step error correction). No data exists either way. This plan produces
   that data.
2. **Harness confound.** Prior rounds graded in our own calibration harness,
   leaving a standing transfer question (Phase-0 C3 existed to bound it).
   This plan removes the question instead of bounding it: **every number is
   produced by the benchmark's own harness**, end to end. FusionKit
   participates only as an OpenAI-compatible model endpoint
   (`fusionkit serve`); the harness never learns fusion happened.
3. **Harness-invariance is assumed, cheaply testable, and worth having.**
   The k=1 engine behavior is a pure function of (conversation, toolset) —
   it does not know which scaffold is driving. Results measured under one
   benchmark harness should therefore transfer across scaffolds up to
   distribution shift (toolsets, system prompts, step granularity). Running
   under real benchmark harnesses makes that assumption load-bearing in the
   right direction: the measured setting *is* the claimed setting.

## 3. Ground rules

- **k=1 everywhere.** No trajectory-level fusion, no lookahead variants in
  round 1; one proposal per member per step, one committed step.
- **Benchmark harness only.** No reimplemented graders, no bespoke
  scaffolds, no task-set substitutions. If a benchmark does not provide a
  runnable harness, the round on that benchmark **stops before spend** and
  the gap is escalated for a joint decision (see §4 — this is already the
  case for one candidate).
- **The comparison table per benchmark** (all rows produced by the same
  benchmark harness, same task set):
  1. each panel member solo (N runs) — field shape, and the task-level
     oracle/headroom for free;
  2. the fused N-member k=1 endpoint (1 run) — what users get;
  3. published frontier baseline for context (cited, not re-run, unless
     cheap).
- **Existing rigor rules carry over unchanged:** pre-registration frozen
  before billed calls, pinned task manifests, spend caps + ledgers,
  truncation/validity audits (these are provider artifacts, not harness
  artifacts, and apply regardless), Wilson/bootstrap CIs, recompute from
  artifacts.
- **Observability without interference:** FusionKit logs every step's N
  proposals + judge decision server-side. This adds diagnostics (judge
  agreement, per-step selection distribution) without touching the harness.
  Committed-step counterfactuals are out of scope — they are unknowable
  without re-runs at k=1, and we accept that.

## 4. Benchmark harness survey (what exists, verified 2026-07-06)

| Benchmark | Harness provided? | Model plug-in point | Notes |
|---|---|---|---|
| **Terminal-Bench** (1.x `tb`, 2.0 `harbor`) | **Yes — full.** Dataset + execution harness + built-in agents (`terminus`/`terminus-2`) distributed by the benchmark. | `--model` arg / `--agent-kwarg gateway_url=<openai-compatible-url>` | Cleanest fit. The harness drives its own agent loop against our endpoint; leaderboard rows are (agent, model) pairs, so "terminus + fused-endpoint" is a legitimate submission shape. |
| **SWE-bench Verified** | **Yes — grading**; scaffold **endorsed** rather than bundled. Official evaluation harness (Docker, or free `sb-cli` cloud grading) grades predicted patches. For running the agent, the benchmark's own bash-only leaderboard standardizes on **mini-SWE-agent** — benchmark-endorsed, minimal, supports OpenAI-compatible endpoints. | mini-SWE-agent `--model` (litellm) → `fusionkit serve`; grade with `sb-cli` / official harness | Using mini-SWE-agent is the closest thing to "the benchmark's harness" for the agentic half; we adopt it and record its exact version, as the leaderboard does. |
| **Aider polyglot** | **Yes — full.** The benchmark harness *is* aider's own benchmark runner (fixed two-attempt loop + per-exercise unit tests). | aider's OpenAI-compatible model config | The harness embeds aider's agent behavior; that is the benchmark's definition, so it is not a confound — it is the setting. |
| **LiveCodeBench** | **Grading only — no agentic harness.** Official repo provides single-completion generation + hidden-test grading. There is no tool loop, so **k is undefined here**: a "k=1 run" degenerates to the single-shot regime already measured in Phase 0. | n/a | **Escalation per ground rule:** LCB cannot test step-level fusion. Options when we get to it: (a) drop it from this plan (recommended — algorithmic was measured lopsided anyway, `c3r16k_report.md`); (b) keep it only as a no-tools sanity row using the official grader instead of our sandbox. Decision deferred to the check-in. |

## 5. Engineering prerequisites (before any billed run)

1. **Sync with `main`.** Step mode (`--k`, step judge/synthesizer prompts,
   `panel_mode: "step"`) landed on `main` after this branch diverged
   (commits `4bb4df3`, `8607fa9`, `b67e407` et al.). The experiment code
   must come from a merge of `origin/main` into this branch (~5 overlapping
   files; `uv.lock`/`pyproject.toml` regenerate via `uv sync`).
2. **Endpoint smoke.** `fusionkit serve` with an N=2 panel, k=1, one tools
   request; verify one member's tool-call batch is committed verbatim.
3. **Harness smoke (no spend cap risk).** One Terminal-Bench task with
   `--agent terminus --model <fused endpoint>`; one SWE-bench instance
   through mini-SWE-agent + `sb-cli`. Oracle-agent dry runs where the
   harness offers them (`--agent oracle`) to validate the environment
   without model calls.
4. **Pre-registration** for round 1 (task slice, N, panel membership from
   the oss-scan shortlists + lineage veto, judge, spend cap, pass rules),
   frozen before billed calls, in `analysis/k1-round1/preregistration.md`.

**Execution-order amendment (2026-07-07):** the SWE-bench arm
(`analysis/k1-swebench/`, mini-SWE-agent v2) is the **primary** arm and
runs first: its scaffold sends native `tools`, so it measures the shipped
step-mode path (built-in step prompts, verbatim tool-batch adoption) with
no prompt adaptation. The Terminal-Bench arm (`analysis/k1-round1/`) is
the secondary/robustness arm for text-protocol harnesses; its pinned
prompts are recorded as preregistration amendments there.

## 6. What this plan does NOT do

- No custom grading, no candidate banks, no offline judge-replay search —
  those live in the lab-loop track and are explicitly labeled
  terminal-answer-regime machinery there.
- No panel/judge hill-climbing on benchmark scores: round 1 measures one
  pre-registered configuration per benchmark. Search, if any, happens after
  we know whether k=1 fusion works at all.
- No public claims: these are tier-CAL-equivalent decision numbers until a
  frozen finalist re-runs the full official task set (the existing Step-5
  rule).
