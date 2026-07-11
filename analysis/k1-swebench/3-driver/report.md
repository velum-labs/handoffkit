# Round 3 report: driver topology via prompt override — negative, confounded

Preregistration: `preregistration.md`. Spec: `docs/fusion/driver-topology-spec-2026-07.md`.
Numbers recomputed from official harness reports + proxy capture. Same
30-instance 2A' slice; baselines reused.

## Results

| row | resolved | Wilson 95% |
|---|---|---|
| solo-terminus | 20/30 (66.7%) | [49%, 81%] |
| solo-qwen3 | 12/30 (40.0%) | [25%, 58%] |
| oracle(solo) | 21/30 (70.0%) | — |
| 2A' fused (synthesize-commit) | 18/30 (60.0%) | [42%, 75%] |
| **3 fused (driver via prompt override)** | **14/30 (46.7%)** | [30%, 64%] |

H1 (floor), H2 (≥ 2A' fused): **both FALSE.** vs terminus-solo: lost 8,
gained 2. vs 2A' fused: −4.

## Why it lost — not judgment, convergence

Loss-mode breakdown of the 16 non-solves:

- **10/30 instances failed to converge**: 6 empty patches + 4 never
  completed. Only 2 were step-limit deaths; the other 8 simply never
  produced a submission. The 2A'/round-1 synthesize-commit rows had ~0
  empty patches. The driver *prompt* degraded the agent's
  progress-to-submission behavior.
- The remaining losses are ordinary hard-task failures.

So the 14/30 is dominated by a **submission-protocol regression caused by
the specific prompt**, not by the commit-authorship semantics the spec is
about. This is a confounded test of the topology.

## The real lesson: G2 cannot be delivered by a prompt

The spec's floor guarantee (G2: "ignorable advice ⇒ committed trajectory =
driver's solo trajectory") assumes that, absent useful advice, the driver
runs **its normal solo behavior**. A synthesizer_system override violates
that assumption at the root: even with empty advice the driver is now
running a *different system prompt* than its solo self, so its floor is
"terminus-under-a-rewritten-prompt" (which converges worse), not
"terminus-solo". The prompt-override implementation therefore has **no
floor by construction** — exactly why it regressed.

G2 holds only if commit authorship is dispatched **mechanically around the
driver's unmodified generation** (engine-level `commit: select | write`),
not by editing the driver's instructions. This run is evidence that the
config surface for commit policy must be mechanical, not a prompt — which
is also the anti-sprawl conclusion.

## The one positive signal

2 **driver-only solves** — `matplotlib-20826`, `pydata-xarray-6938` —
resolved by the fused driver row and by neither member solo (G3:
deliberation-stage composition produced wins selection could not). Real,
but n=2 and outweighed here by the convergence regression. It survives as
motivation for the mechanical implementation, where composition can be
measured without the prompt confound.

## Verdict

- Driver topology **as a prompt override**: rejected (14/30, convergence
  regression, no floor).
- Driver topology **as a mechanism**: untested — this run does not measure
  it, because a prompt can't hold G2. The clean test requires the engine
  change (`commit` dispatched around the driver's own generation, harness
  submission contract preserved).
- Cost: one fused row, ~$6-8 (proxy/OpenRouter export authoritative).

## Next (if pursued)

Implement `commit: select | write` in `JudgeSynthesizer` as engine
dispatch (not a prompt): `select` copies the judge-named candidate's
tool_calls bytes; `write` keeps the driver's normal step prompt +
appends advice as context, commits the driver's own single generation.
Re-run this exact comparison. Prediction stands only for the mechanical
form.
