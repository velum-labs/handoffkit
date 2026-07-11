# 2A' failure-case analysis: where the fused row lost winnable instances

All numbers recomputed from the 2A' provider-call capture
(`runs/fused/provider_calls.jsonl`, per-step reconstruction via
`../scripts/analyze_autopsy.py`), solo trajectories, and official grading
logs. No new spend.

## The three decisive instances

### `django__django-14500` — the judge was RIGHT and the pipeline ignored it

qwen3 solves this solo in 23 steps (its one unique solve). In the fused
run the judge preferred qwen3's proposals **39 of 53 named verdicts** — it
identified the right horse. But the synthesizer adopted qwen3's batch
verbatim only **5 of 60 steps** and free-composed **41 of 60**. The fused
patch (1007B) matches neither member and fails the target test.

**Mechanism: synthesizer override.** A correct judge preference was
diluted into composition. This instance alone shows the pipeline can lose
a win the panel already contained *even when the judge votes correctly*.

### `sympy__sympy-14248` — abstention causes drift toward the weaker member

terminus solves this solo (109 steps, hard task); qwen3's solo run
produced an **empty patch**. In the fused run the judge abstained on
**97 of 130 steps (75%)**; commits split 46 qwen3-verbatim / 32
terminus-verbatim / 52 composed — the trajectory drifted toward the
member that cannot solve the task at all, on exactly the instance where
following the strong member mattered.

**Mechanism: abstention → free composition → drift.** With no verdict,
nothing anchors the trajectory to the stronger member's path.

### `django__django-13837` — coin-flip thrash

terminus solves solo in 40 steps. The fused run took 78: commits split
almost exactly evenly (25 terminus-verbatim / 26 qwen3-verbatim / 27
composed), judge followed on only 8 of 31 contested named steps. The
final patch (2182B) fixes neither cleanly (1 F2P failure).

**Mechanism: path alternation.** Verbatim-commit semantics exist so ONE
candidate's plan advances; instead the committed path alternated owners
nearly every step.

## The common structure

None of the three losses is a judging-quality failure in the narrow
sense. They are **commit-pipeline failures**, and they are the same two
defects the 2B/2C rounds measured as prompt-resistant:

| defect | measured rate (2A' fused row) | failure case it caused |
|---|---|---|
| synthesizer ignores/overrides the named verdict | verbatim-follow 29% on contested steps | django-14500 (judge right, output composed) |
| judge abstains, synthesizer free-composes | null 57.9% of 1417 steps | sympy-14248 (drift), django-13837 (thrash) |

2C established that prompts cannot fix either (byte-for-byte prompt:
22%→29%; never-null prompt: abstention got *worse*). The remaining lever
is mechanical, in the engine:

1. **Select-commit on the tools path**: when the judge names
   `best_trajectory`, emit that candidate's batch verbatim and skip the
   synthesizer call — the exact analogue of the no-tools
   `synthesis_select_best` path. Compliance becomes 100% by construction
   and each step drops one LLM call (~30% latency/cost).
2. **Default-member fallback on abstention**: when the judge returns
   null, commit the configured default member's proposal verbatim instead
   of composing. The fused system's floor becomes the best member's path;
   deviations happen only on affirmative judge preference.

Predicted effect against these cases: 13837 and 14248 stay on terminus's
solving path unless the judge affirmatively objects; 14500 becomes a win
if the judge's 39/53 qwen3 preference expresses even a few times at the
right steps. Panel composition unchanged.
