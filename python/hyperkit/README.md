# hyperkit

A system-under-test-agnostic experiment orchestration platform.

hyperkit runs **hypergrid sweeps**: a matrix of experiment cells, each a
`(system-under-test x benchmark x instance)` shard, executed on a pluggable
compute backend, graded by a pluggable grader, and aggregated into honest
tables (Wilson intervals, oracle/headroom/capture). It is built around a few
ideas:

- **The matrix is code.** An `Experiment` implements `cells(ctx)` (and optional
  `on_results`), so arbitrary logic — computed axes, constraints, registry
  lookups, result-conditioned follow-ups — generates cells. `CartesianExperiment`
  is the stock declarative (YAML) implementation of the same contract.
- **Content-addressed shards + append-only generation log.** Every shard has a
  stable hash; the results store *is* the checkpoint. Sweeps are resumable
  (`status`/`resume`) and growable (`extend`) without losing determinism.
- **The SUT is opaque.** hyperkit core imports no `fusionkit_*`; it treats the
  system under test as hashable configuration. FusionKit participates as a SUT
  plugin registered via entry-points. So do bare models, HandoffKit, etc.

The core (`hyperkit.core`) never imports SUT-specific code; a CI import-boundary
test enforces this.
