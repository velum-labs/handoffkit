# Automated Prompt Tuning (decision-only, frozen candidate bank)

Hillclimb the judge / synthesizer / verifier prompts on a small subset before any
full-scale run, as automatically as possible. An optimizer LLM proposes prompt
rewrites from failures; each proposal is scored by replaying only judge+synth over
a frozen candidate bank and re-verifying by execution.

## Why it is cheap

Panel candidates are expensive and do not change when you tune the judge/synth
prompt, so we generate them once into a candidate bank. Each tuning iteration then
runs only 1 judge + 1 synth (+ optional verify) call per dev task over the cached
candidates - typically 3-5x cheaper than a full panel pass - and caches results by
prompt hash so repeats are free and the loop is resumable.

## The loop

1. Build a candidate bank once (`candidate_bank.py`): one panel pass per task,
   storing the prompt, tests, each candidate's output, and whether it passes.
2. Select the decision subset (`select_decision_tasks`): tasks where candidates
   disagree (some pass, some fail) - the only tasks where the judge changes the
   outcome. Split deterministically into dev (optimizer sees it) and held-out val.
3. For each proposed prompt, replay judge+synth over the bank, verify by execution,
   and score (`evaluate_variant`).
4. The optimizer LLM (`LLMProposer`) proposes a new prompt from the current best,
   the score trajectory, and dev failure exemplars.
5. Accept on dev only if it wins paired (`mcnemar`); promote the final prompt by
   held-out val with a Wilson CI.

## Run it

```bash
uv run --with 'datasets<4' fusionkit tune-prompts \
  --config configs/benchmark-panel.example.yaml \
  --role synthesizer_system \
  --subset 40 \
  --max-iterations 8 --patience 3 \
  --prompts-out .fusionkit/prompts \
  --report out/tuning.md
```

The bank is built on first run and reused after. Untrusted candidate/fused code
runs in the sandbox (`BENCH_SANDBOX=local|docker`).

## Guardrails against overfitting

- The optimizer only ever sees the dev set; val is held out and used only for
  promotion. The headline is the val score, not dev.
- Acceptance requires a paired net win (McNemar), not just a nominal score bump.
- Patience-based early stop plus a max-iteration cap limit the number of trials
  (mitigating multiple-comparisons noise).
- A tuned prompt is written to `.fusionkit/prompts/` only when it improves val;
  review it before adopting (the optimizer edits prompts only, never the harness).

## Ceiling

The judge cannot execute tests at decision time, so prompt tuning only captures
what textual judging can infer about which candidate is correct. The higher lever
- execution-grounded selection (run candidates against tests and prefer a passing
one) - is intentionally separate; this loop makes its absence measurable as
residual judge regret.
