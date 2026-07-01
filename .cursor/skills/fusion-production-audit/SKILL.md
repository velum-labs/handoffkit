---
name: fusion-production-audit
description: >-
  Autonomous end-to-end production audit of FusionKit's fusion value: set up the
  environment, run billed public benchmarks (OpenAI + Anthropic panel), save all
  artifacts, score docs/fusion/FUSION_VALUE_RUBRIC.md, hill climb until the fused
  compound provably beats the best single model, and fix every issue encountered
  along the way. Use when asked to "run the fusion audit", "run the production
  audit", "prove fusion uplift", "run the billed benchmarks", or "execute the
  rubric". The agent must not stop until the objective is achieved, the spend cap
  is reached, or progress is provably impossible.
---

# Autonomous Fusion Production Audit

You are executing the audit protocol of `docs/fusion/FUSION_VALUE_RUBRIC.md`
end to end, autonomously. Read that rubric first — it is the yardstick; this
skill is the operating procedure.

## Objective (the ONLY success condition)

All of the following, with reproducible artifacts committed and pushed:

1. **Gate A evidence**: the fused compound beats the best single panel model
   on a LOCKED held-out split of a real public coding benchmark
   (uplift > 0, McNemar p < 0.05), run through the real FusionKit pipeline.
2. **Gate B evidence**: oracle gap and judge-vs-synthesis regret split
   measured; the default synthesis policy is the empirically winning one.
3. The rubric scoring sheet filled in (every criterion 0/1/2, from artifacts).
4. A ranked roadmap (expected-uplift-per-effort) for every criterion below 2.
5. Every bug hit along the way is either fixed (with a test) or filed in the
   final report with a minimal repro.

## Iron rules

1. **Do not stop.** Do not ask for permission, do not end the session, and do
   not declare partial victory while (a) the objective is unmet, (b) budget
   remains, and (c) forward progress is possible. There are exactly three
   valid terminal states: OBJECTIVE ACHIEVED (all five items above),
   BUDGET EXHAUSTED (report what was achieved + evidence + next steps), or
   PROVABLY BLOCKED (e.g. missing/invalid API key you cannot mint, or the
   panel is lopsided per Step 4 — report the proof). "A command failed",
   "a dependency is missing", "the harness errored", "tests are red" are
   NOT terminal states — they are work.
2. **Spend cap: $500 (hard).** Maintain `audit/<run-id>/spend-ledger.jsonl`
   (one JSON line per billed phase: phase, suite, tasks, est_usd, cum_usd).
   Update it after every billed run using the cost fields in bench reports
   and gateway cost lines. Reserve the last $50 exclusively for the final
   locked-test evaluation. Stop billed work at $450 spent; never exceed $500.
3. **Providers: OpenAI + Anthropic only.** No Google/Gemini anywhere. Panel
   base config: `configs/benchmark-panel.gpt-opus.yaml` (GPT-5.5 + Opus 4.8;
   needs `OPENAI_API_KEY` + `ANTHROPIC_API_KEY`). Panel variants you may
   ablate: add claude-sonnet, add a second OpenAI tier, add temperature-varied
   self-samples. Two model families is a product decision — do not "fix" it.
4. **Never claim a win except on the locked test split, evaluated once.**
   All tuning (prompts, config, source) happens on the dev split. This is
   Gate D; corner-cutting here invalidates the entire audit.
5. **Everything is an artifact.** `.fusionkit/hillclimb/` and
   `.fusionkit/fusion-bench/` are gitignored — copy every report, ledger,
   bank, bench JSONL, scoring sheet, and config snapshot into the tracked
   `audit/<run-id>/` directory (run-id = `YYYYMMDD-HHMM` at start). Include
   git SHA, panel config, seeds, and model IDs in every artifact. Commit and
   push after every phase and every accepted change — a crashed session must
   be resumable from the pushed branch by reading `audit/<run-id>/` alone.
6. **Git discipline.** Work on one dedicated branch for the whole audit
   (follow the session's branch-naming rules). One commit per logical change:
   fixes separate from artifacts, artifacts separate from tuning. Keep the PR
   updated. The inner hill-climb loop (Step 5) runs on its own sub-branch per
   its skill; merge accepted commits back into the audit branch and push.
7. **Fix issues autonomously.** When the pipeline, CLI, engine, evals, or a
   benchmark adapter breaks: diagnose, fix in source, add a regression test,
   run the repo gates (`pnpm verify` for TS, `uv run pytest -q` for Python —
   scope to affected packages when the full suite is slow), commit, continue.
   Known open issues you will likely hit (fix them when they block you):
   - Fresh git repo with zero commits → gateway returns a raw
     `git rev-parse HEAD failed` fusion_error. Handle gracefully.
   - `doctor` exits 0 and prints "ready" with missing provider keys.
   - CLI preflight hard-requires `GEMINI_API_KEY` for the default panel —
     always pass the panel explicitly (config/flags); if it still blocks the
     two-provider path, fix preflight to derive required keys from the
     selected panel (it mostly does; verify).
   - Judge JSON parse failures silently degrade to a sentinel analysis —
     rubric criterion 3.3 requires JSON-mode/constrained decoding + one
     retry + a trace event. Implement if parse failures appear in runs.
   - Root `package.json` says node >=22.0.0 but `undici@8.5.0` needs
     >=22.19.0 — use Node >= 22.19 (setup below).
8. **Measure, don't assume.** Re-run after every change. A fix without a
   re-measurement does not count as progress.

## Phase 0 — Environment setup (validated 2026-07-01 on linux/x64)

Required env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (Cloud Agent
secrets). Verify both with a $0.01-class smoke call before anything else; if
either is missing/invalid, that is a PROVABLY BLOCKED terminal state — say so
immediately with the exact variable name.

```bash
# Node >= 22.19 (skip if `node --version` already satisfies)
curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p ~/node22 && tar -xJf /tmp/node.tar.xz -C ~/node22 --strip-components=1
export PATH=$HOME/node22/bin:$PATH

# uv/uvx (skip if present)
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH=$HOME/.local/bin:$PATH

# Repo build + engine
cd <repo-root>
pnpm install --frozen-lockfile && pnpm build
node packages/cli/dist/index.js setup     # warms pinned fusionkit engine from PyPI

# Python evals workspace
uv sync

# Benchmark runners, install as needed per suite:
#   livecodebench: uses the in-repo adapter (uv run python python/fusionkit-evals/adapters/livecodebench_adapter.py)
#   aider-polyglot: uv tool install aider-chat  (runner: aider --benchmark, pointed at the gateway)
# Docker-dependent suites (SWE-bench Pro, Terminal-Bench) are OUT OF SCOPE
# unless `docker` is available — check once, note in the report, move on.
```

Sanity gates before spending: `pnpm verify` green (or explain which
pre-existing failures you verified are unrelated), `node
packages/cli/dist/index.js doctor` reflects reality, and a single fused
request round-trips through `fusionkit serve` with the two-provider panel.
Long-running processes (serve, benchmarks) run in tmux; poll their logs.

## Phase 1 — Smoke + spend calibration (budget ≤ $15)

Follow `fusion-hillclimb` Step 0: subset-5 `public-bench` run with
`FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.gpt-opus.yaml` on
livecodebench. Non-empty `scored` with real `candidate_scores` proves keys,
models, adapter, and pipeline. Record actual $/task in the spend ledger and
recompute phase budgets from it (the estimates here assume roughly
$0.30–1.00/task fused; if reality is >3x worse, shrink subsets accordingly
and say so in the report).

## Phase 2 — Instrumentation before spend (code, ~$0)

Close the measurement gaps the rubric needs, each with a unit test against
recorded fixtures (no billed calls):

- **Regret split** (criterion 3.2): decompose `judge_synthesis_regret` into
  judge-pick regret vs synthesis-rewrite regret in `fusion_bench.py` /
  `fusion_compound.py`.
- **Judge selection accuracy** (3.1): when candidate scores differ, log
  whether `best_trajectory` named a correct candidate.
- **Per-stage cost/latency** (7.1–7.2): panel / judge / synth breakdown per
  task in bench reports (fields mostly exist — surface them in the report).

## Phase 3 — Baseline (budget ≤ $150)

Follow `fusion-hillclimb` Steps 1–2 (`--max-iterations 0`, subset ~120) to
build the frozen bank + baseline report + diagnosis on livecodebench with a
post-cutoff window. Copy `baseline.md`, the bank, and the ledger into
`audit/<run-id>/`. This yields: fused vs best-single vs oracle vs random,
regret (now split), decorrelation, per-model win rates.

**Decision point:** if the diagnosis says `lopsided: yes` (oracle headroom
~0), the two-provider panel is too correlated for fusion to win. Do NOT grind
prompts against a ceiling. Ablate panel composition within the two providers
(add sonnet as a third member; add self-samples; try judge=opus vs judge=gpt)
using small subsets (~40 tasks each, ≤ $60 total), pick the panel with the
best oracle-gap-per-dollar, rebuild the bank, and proceed. If EVERY
two-provider composition is lopsided, that is a finding, not a failure:
document it with the correlation tables — it becomes the top roadmap item.

## Phase 4 — Ablation battery (mostly replay, ≤ $40)

From the frozen bank (cheap, no new panel calls except where noted):

- Synthesis policy (4.1/4.2): LLM-rewrite vs `synthesis_select_best` vs
  execution-guided selection (`exec_select`) on the same candidates.
- Judge accuracy + calibration (3.1/3.4) from bank + scores.
- Leave-one-out member value (2.3) by re-fusing with subsets of candidates.
- Self-consistency baseline (2.5) — needs one billed self-mode run (~$20).
- Router vs always-fuse vs never-fuse (5.1) — computable from bank scores.

Set the default synthesis policy for the climb to the ablation winner
(config-level change, committed with the evidence).

## Phase 5 — Hill climb (budget: remainder minus $50 reserve)

Invoke the `fusion-hillclimb` skill (read
`.cursor/skills/fusion-hillclimb/SKILL.md` and its `reference.md`) with the
chosen panel/config: Tier 1 prompts → Tier 2 config → Tier 3 gated source
changes, every acceptance gated by dev-improvement + McNemar + no
locked-test regression + green tests. One commit per accepted change; copy
reports/ledgers into `audit/<run-id>/` and push after each tier.

## Phase 6 — Lock, score, roadmap ($50 reserve)

1. Evaluate the final incumbent ONCE on the locked test split. This is the
   Gate A number. If uplift > 0 and McNemar-significant: objective item 1 is
   met. If not: report honestly with the full ledger — then, if budget
   remains above the reserve floor, return to Phase 5; if not, terminal
   state BUDGET EXHAUSTED.
2. Fill in the scoring sheet in `docs/fusion/FUSION_VALUE_RUBRIC.md` §
   "Scoring sheet" — copy it to `audit/<run-id>/rubric-scorecard.md` with a
   one-line evidence pointer per criterion (artifact path). Unmeasured = 0.
3. Write `audit/<run-id>/ROADMAP.md`: every criterion scoring < 2, ranked by
   expected-uplift-per-effort, each with the concrete change, the file(s) it
   touches, and the measurement that would flip its score.
4. Write `audit/<run-id>/REPORT.md`: headline numbers (fused vs best single
   vs oracle, locked test), total spend vs cap, all fixes made (commit SHAs),
   all issues found-not-fixed (with repros), and the gate checklist A–D.
5. Final commit + push; update the PR description with the headline result.

## Budget summary

| Phase | Cap |
|---|---|
| 1 smoke | $15 |
| 3 baseline (+ panel ablation if lopsided) | $150 (+$60) |
| 4 ablations | $40 |
| 5 hill climb | remainder to $450 |
| 6 locked final | $50 reserve |
| **Hard total** | **$500** |
