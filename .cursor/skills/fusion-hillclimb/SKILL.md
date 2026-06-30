---
name: fusion-hillclimb
description: >-
  Self-healing hill climb that drives FusionKit's fused compound to provably beat
  the best single panel model on an unsaturated benchmark. Use when asked to "hill
  climb fusion", "improve the fusion benchmark", "make the compound beat the best
  model", "reduce judge/synthesis regret", "self-heal fusion", or to autonomously
  optimize the panel/judge/synthesizer until fusion wins. Runs an escalating,
  budget-capped loop (prompts -> config -> gated source changes), measured on a
  locked held-out test split.
---

# Fusion Hill-Climb (self-healing)

Drive the fused compound to beat the best single model (e.g. GPT-5.5 vs Claude
Opus 4.8) on an unsaturated benchmark, autonomously, within a budget. Run from the
fusionkit repo root.

## Iron laws

1. Never claim a win except on the LOCKED test split, evaluated once at the end.
2. Accept a change only when ALL gates pass (below). Otherwise revert it.
3. Stay on a dedicated git branch; commit each accepted change; never push.
4. Stop at the budget cap (default $100), the iteration cap, or the target.
5. Measure, don't assume. Re-run the engine after every change.

## Inputs

- Panel config: `configs/benchmark-panel.gpt-opus.yaml` (GPT-5.5 + Opus 4.8).
- Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- Budget: default $100 per climb run.
- Target: fused pass@1 minus best-single pass@1 on the locked test split, McNemar-significant.

## Workflow

Copy this checklist and track progress:

```
- [ ] 0. git branch + smoke (subset 5) to validate keys/model names/dataset
- [ ] 1. Baseline: public-bench + compound-vs-individual table; record fused vs best-single
- [ ] 2. Diagnose: oracle headroom, regret, decorrelation (fusion-hillclimb prints this)
- [ ] 3. Tier 1: climb judge + synthesizer prompts (cheap, frozen-bank replay)
- [ ] 4. If target not met and budget remains: Tier 2 (config knobs)
- [ ] 5. If still not met: Tier 3 (gated synthesis source changes)
- [ ] 6. Final: evaluate the incumbent ONCE on the locked test; write report + ledger
```

### Step 0: branch + smoke

```bash
git checkout -b fusion-hillclimb/$(date +%Y%m%d-%H%M)
FUSIONKIT_BENCH_CONFIG=configs/benchmark-panel.gpt-opus.yaml \
  uv run fusionkit public-bench --suite livecodebench --subset 5 \
  --runner-command "uv run python packages/fusionkit-evals/adapters/livecodebench_adapter.py" \
  -o .fusionkit/hillclimb/smoke.jsonl
```
A non-empty `scored` count with real candidate_scores confirms the panel works. Abort if models/keys do not resolve.

### Step 1-2: baseline + diagnosis

Build the frozen bank and print the diagnosis + locked-test target in one shot:

```bash
uv run fusionkit fusion-hillclimb -c configs/benchmark-panel.gpt-opus.yaml \
  --subset 120 --max-iterations 0 \
  --bank .fusionkit/hillclimb/bank.json \
  --report .fusionkit/hillclimb/baseline.md --ledger .fusionkit/hillclimb/ledger.jsonl
```

Read `baseline.md`. If `lopsided: yes` (oracle headroom ~ 0), the panel is too
correlated -- fusion cannot win regardless of prompts; report this honestly and
stop (or change the panel). Otherwise headroom exists -> climb.

### Step 3: Tier 1 (prompts)

Climb the synthesizer, then the judge (each gated by McNemar vs the incumbent):

```bash
uv run fusionkit fusion-hillclimb -c configs/benchmark-panel.gpt-opus.yaml \
  --role synthesizer_system --bank .fusionkit/hillclimb/bank.json \
  --max-iterations 8 --patience 3 \
  --report .fusionkit/hillclimb/synth.md --ledger .fusionkit/hillclimb/ledger.jsonl
# then --role judge_system
```

Accepted prompts are written to `.fusionkit/prompts/*.md` only when they improve
the LOCKED test. Commit each accepted prompt: `git add .fusionkit/prompts && git commit`.

### Step 4-5: Tier 2 / Tier 3

Only if the target is not met and budget remains. See [reference.md](reference.md)
for the Tier-2 config search and the Tier-3 source-change procedure (both reuse
`fusion-hillclimb` to re-measure and are bound by the same gates).

### Step 6: final

The last `fusion-hillclimb` run already reports the locked-test result. Summarize:
the compound-vs-individual table (`compare_compound_vs_individual`), the locked-test
fused-vs-best-single delta + McNemar, the iteration ledger, and total spend.

## Gates (every accepted change)

- Correctness: `uv run pytest -q` green (and `pnpm -C ../handoffkit build && pnpm -C ../handoffkit test` for cross-repo synthesis changes).
- Quality: improves on dev AND McNemar-significant vs incumbent AND locked-test uplift > 0 (do not regress val).
- Budget: running spend < cap; stop before exceeding it.
- Safety: on the climb branch; one commit per accepted change; ledger updated; never push.

## Stopping

Stop when: locked-test fused beats best-single (uplift > 0, McNemar-significant);
OR budget exhausted; OR no accepted improvement for `patience` iterations across all
tiers. Then write the final report.

## Reference

- Metric definitions, escalation heuristics, and the Tier-3 source-change patterns: [reference.md](reference.md)
