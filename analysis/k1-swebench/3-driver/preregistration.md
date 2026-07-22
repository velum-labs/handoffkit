# Round 3 preregistration: driver topology (commit: write)

Frozen before the billed run. Spec: `docs/fusion/driver-topology-spec-2026-07.md`.

## Hypothesis

The 2A' fused row lost 2 of terminus's 20 solo solves and gained 0 because
the step-mode synthesizer was framed to "adopt exactly ONE candidate's tool
batch verbatim" — a transcription task it fails (verbatim compliance ~29%),
producing committed steps that drift off the driver's path. Reframing the
decider to **write its own next step using the panel proposals + judge
analysis as advice** (driver topology, Invariant D: one author, no splice)
should:

- **H1 (floor, G2):** eliminate below-driver losses — fused resolves ⊇ a
  driver-solo-like set; best-member-loss rate → ~0 except driver-chosen
  deviations.
- **H2 (no worse):** fused resolved ≥ 2A' fused (18/30).
- **H3 (insight, G3):** any gain over terminus-solo (20/30) comes only via
  the driver acting on admissible advice.

This is a **mechanism test**, not variant selection: one pre-registered
config, controlled against existing baselines on the same slice.

## Design

- Config: `config/driver.yaml` — a synthesizer_system override implementing
  commit: write. Nothing else changes vs 2A': same panel (terminus+qwen3),
  judge (terminus), scaffold (mini-SWE-agent v2 stock), grading (official
  harness), slice.
- Slice: the 2A' 30-instance manifest (`../2a/instance_manifest.txt`).
  Baselines reused (no rerun): solo-terminus 20/30, solo-qwen3 12/30,
  oracle 21/30, 2A' fused (synthesize-commit) 18/30.
- One new billed row: `fused-driver`. Provider calls captured via proxy for
  process metrics.

## Read-outs (recomputed from official reports + proxy)

1. fused-driver resolved / 30, Wilson 95%.
2. vs terminus-solo: gained set, lost set (H1 -> lost ≈ ∅).
3. vs 2A' fused: delta (H2).
4. Process: per-step, did the committed tool_calls equal one advisor's batch
   (copy) vs a driver-authored batch (write)? Confirms the topology is
   actually writing, not degenerately echoing. Judge null rate recorded but
   not acted on (driver writes regardless).

## Interpretation

- lost ≈ ∅ and resolved ≥ 20: H1+H2 hold — the topology removes the tax; the
  floor guarantee is real. Proceed to fresh-slice confirmation + formalize
  `commit: write` as the engine default for act steps.
- resolved < 20 with losses: floor claim fails empirically — driver is being
  pulled off its path by advice even when authoring; investigate via traces
  before any engine change.
- resolved > 20: H3 — advice added value; the headline positive result.

## Spend

Cap $8 (one fused row, ~30 instances). Abort if it exceeds $8 mid-run.

## Deviations

None at preregistration time.
