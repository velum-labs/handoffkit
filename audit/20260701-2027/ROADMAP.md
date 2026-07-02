# Roadmap — every criterion below 2, ranked by expected-uplift-per-effort

Audit 20260701-2027. "Uplift" = expected movement on the rubric's hard gates
and headline numbers; effort = code scope. Ordered highest leverage first.

## Tier 1 — closes hard gates

1. **1.1/1.2 at level 2 — bigger locked evidence (Gate A).**
   The +18.6-pt LCB result is real but n=86; polyglot is +0.97 ns because the
   panel saturates it (best single 0.767, ceiling 0.854). Change: (a) extend
   the locked LCB window when release_v7 ships (post-2025-05 problems reach
   n≥200 paired), (b) swap the second family to a harder agentic suite
   (SWE-bench-Lite-class via the gateway; needs Docker in the eval host) where
   best-single ≈40–50% leaves fusion room.
   Files: `python/fusionkit-evals/adapters/` (new adapter), CI eval host.
   Measurement that flips it: locked run, uplift>0, p<0.05, n≥200.

2. **7.4 prompt caching (Gate C).**
   Panel is 89% of locked-run cost ($22.55/$25.24); every judge/synth call
   re-sends candidates uncached. Anthropic `cache_control` + OpenAI cached
   prefixes on panel/judge/synth calls.
   Files: `fusionkit_core/clients.py` (both cloud clients), stage metrics
   already meter tokens to verify the ≥50% input-token claim.
   Measurement: cache-hit rate + input-token cost on a multi-turn session.

3. **7.3 straggler hedging (Gate C + 7.2).**
   Locked-run panel p95 83s = slowest of 6 samples; quorum-4-of-6 with
   early-cancel cuts p95 without quality loss (oracle rarely lives in the
   slowest sample — verifiable from the bank).
   Files: `fusionkit_core/producers.py::_settle` (+ config knob).
   Measurement: p95 latency delta + paired quality check on a dev bank.

4. **9.1/9.2 tool-enforced holdout + scheduled bench (Gate D).**
   Manifests exist; make tuning jobs physically unable to read the locked
   manifest (path allowlist in `fusion_hillclimb`/`tune-prompts`) and run the
   public-bench suite per release in CI with ledger drift gating.
   Files: `fusionkit_cli/main.py`, `.github/workflows/ci.yml`.
   Measurement: 2+ scheduled runs land as comparable artifacts.

## Tier 2 — highest headline upside

5. **5.4 difficulty-adaptive depth (cost-per-solve fix for 7.1).**
   Deep panel is 2.8× cost/solve because it pays 6 samples on tasks the
   shallow panel already solves (32/86 both-pass on the locked window).
   Escalate depth only when the shallow pool disagrees or fails public tests
   (~40% of tasks) → deep quality at roughly half the deep cost.
   Files: `fusionkit_core/fusion.py` (two-phase generation), config.
   Measurement: cost-quality frontier vs fixed-depth presets on the dev bank.

6. **4.3 execution grounding on the live path.**
   Exec-select is SOTA for code in the harness; the gateway never sees test
   signals. Wire public-check execution (lint/build/public tests, leakage
   rules from `exec_select.py`) into the gateway fusion decision when the repo
   has runnable checks.
   Files: `fusionkit_core/judge.py` (selection hook), harness integration.
   Measurement: paired gateway run with/without grounding.

7. **3.2-per-family judge fix (polyglot judge regret 7.8 pts).**
   The gpt judge picks at 79% on full-file multi-language code vs 97–100% on
   LCB. A judge-prompt climb on the polyglot train split (machinery exists:
   `fusion-hillclimb-polyglot --role judge_system`) is the cheapest lever; a
   sonnet/opus judge ablation (3.5) is the second.
   Measurement: polyglot pick accuracy ≥90% + full-bank re-eval significance.

8. **1.5 multi-seed variance.** Three seeds of the deep dev replay (bank fixed,
   judge/synth resampled) + seed-aggregated CIs via `bench_stats`.
   Cheap ($15-class), unlocks a rubric point and hardens every claim.

## Tier 3 — structural

9. **5.2 learned router** consuming kernel outcome records (also closes 9.4);
   HeuristicRouter routes 100% of coding traffic to panel today, so any
   calibrated confidence model beats the frontier trivially.
10. **3.4 judge calibration curve** from the recorded pick-margin data (the
    banks already hold everything needed — pure analysis).
11. **6.x agentic measurements** (tool-call fidelity, staleness, multi-turn)
    once a Docker-capable eval host exists.
12. **8.x reliability drills** (injected provider failures, renamed-model,
    concurrency soak) — mostly test-infra work.
13. **10.x kernel/workflow convergence** — per the architecture review; no
    measurement blocked on it today.
