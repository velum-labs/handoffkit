# Hyperkit

Hyperkit is the system-under-test-agnostic experiment platform extracted from
FusionKit's benchmarking infrastructure.

## Boundary

`hyperkit.core` never imports `fusionkit_*`. It owns:

- code-defined experiments (`Experiment.cells`, optional `on_results`);
- materialized `Cell`s, content-addressed shards, append-only generations;
- resumability (`status`/`resume`) and growable sweeps (`extend`);
- benchmark, grader, SUT, capture, and compute-backend Protocols;
- the sole statistics implementation;
- AWS Batch/Terraform infrastructure and live Grafana observability.

FusionKit is a plugin:

- `fusionkit-serve` is a `SystemUnderTest` registered by the FusionKit CLI
  package's entry point (`python/fusionkit-cli/pyproject.toml`,
  `hyperkit.suts` -> `fusionkit_cli.hyperkit_plugin:factory`); hyperkit core
  itself only ships the `solo-model` SUT;
- `TopologySpec` today materializes a full serve config and boots
  `fusionkit serve`; a bridge that resolves specs directly onto the TypeScript
  `OperatorGraph`/`Scheduler` kernel has not landed yet
  (`fusionkit_cli/hyperkit_plugin.py`);
- Fusion-specific metrics ship as a Grafana dashboard pack.

Built-in benchmark adapters live in `python/hyperkit/src/hyperkit/adapters/`:
`livecodebench`, `swebench_verified` (`swebench.py`), and `terminal_bench`.

## Matrix as code

```python
from hyperkit import Cell, Experiment, TopologySpec, experiment


@experiment(id="k1-grid")
class Grid(Experiment):
    def cells(self, ctx):
        for k in (1, 4):
            yield Cell(
                sut=TopologySpec(
                    kind="fusionkit-serve",
                    params={
                        "serve_config": {
                            "endpoints": [...],  # full serve schema (ModelEndpoint list)
                            "default_model": "terminus",
                            "panel_models": ["terminus", "qwen3"],
                            "default_mode": "panel",
                            "sample_count": k,
                        }
                    },
                ),
                benchmark="swebench_verified",
                instances=ctx.manifest("swebench_verified", "manifest.txt"),
            )
```

The `fusionkit-serve` SUT requires either `params.config` (path to an existing
serve YAML) or `params.serve_config` (an inline dict written out as the serve
config); the payload is opaque to hyperkit and validated by FusionKit's config
loader when `fusionkit serve` boots
(`python/fusionkit-cli/src/fusionkit_cli/hyperkit_plugin.py`).

`hyperkit plan grid.py` evaluates the code once and freezes canonical cells
into `sweep.lock.json`. Shard identity is a hash of materialized SUT config,
benchmark, adapter version, instance, and dataset hash; runners never import the
experiment code.

Reload behavior is explicit:

- `hyperkit resume` uses the frozen lock (code ignored);
- `hyperkit extend grid.py` re-materializes edited code and appends only new
  cells; overlap deduplicates by content hash; `extend --from-results` calls
  `Experiment.on_results` instead of `cells`;
- removed cells are historical, never destructive; results remain queryable.

## CLI

The full command set (`python/hyperkit/src/hyperkit/cli.py`):

- `plan` — freeze an experiment into `sweep.lock.json`;
- `extend` (`--from-results`) — append new cells from edited code or from
  `Experiment.on_results`;
- `apply` (`--backend`, `--rung N`, `--only GLOB`) — submit missing shards
  only; `--rung` limits each cell to its first N instances (halving budget)
  and `--only` filters by cell-label glob;
- `resume` — apply from the frozen lock without re-executing experiment code;
- `pull` — mirror cloud `ShardResult`s from S3 into the local store so
  `status`/`collect` see the same checkpoint the runners wrote;
- `status` / `collect` — progress counts and the aggregated results table;
- `controller` — run the stateless S3/SQS hypergrid snapshot controller;
- `local-controller` — filesystem twin of the cloud controller; publishes live
  `CellSnapshot` gauges from local sweeps over OTLP;
- `replay-swebench` — aggregate committed SWE-bench harness reports into a
  sweep table.

## Local acceptance / replay

Committed official-harness reports can be normalized without provider calls:

```bash
hyperkit replay-swebench \
  --manifest analysis/k1-swebench/3-driver/confirm_manifest.txt \
  --report solo-terminus=...solo-terminus.json \
  --report driver-v2=...driver-v2.json
```

The migration gate reproduces the committed 19/30 vs 16/30 confirmation table.

## Cloud

`infra/hyperkit` provisions:

- AWS Batch Spot EC2 (memory reservation per adapter; scale-to-zero);
- S3 artifact/result lake + Athena/Glue;
- ECR runner image and image-cache storage;
- Secrets Manager/IAM;
- ADOT -> Prometheus/X-Ray streaming telemetry;
- always-on, tailnet-only Grafana dashboards for sweep progress, fleet health,
  and FusionKit internals. Batch/controller telemetry stays on the private VPC
  path; an outbound-only Tailscale connector is the sole dashboard ingress.

The S3 `ShardResult` is the checkpoint. Spot interruption or controller
restart loses at most in-flight shards; `resume` submits only the missing set.

A second, lighter compute substrate exists for the hypergrid/lab runs:
`infra/hypergrid-batch/deploy.py` deploys a Fargate Spot AWS Batch stack (ECR
repository + runner image built from `docker/hyperkit-runner/`, S3 result lake
and problem store, Secrets Manager, IAM, Batch queue/job definition) with no
instance management. Its observability bring-up lives in
`infra/hypergrid-obs/deploy.py` (Prometheus + Grafana on a single EC2
instance, tailnet-restricted). The hypergrid search plan is documented in
`analysis/hypergrid/PLAN.md`, and the shared experiment lab that coordinates
runs on this substrate is described in `lab/AGENTS.md`.

## Live hypergrid performance

Each result-object write emits an S3 notification to an encrypted SQS queue.
The stateless `hyperkit controller` service reconciles the affected sweep from
durable S3 cell metadata + `ShardResult`s, writes a `CellSnapshot` per cell, and
publishes bounded-label OTLP gauges to AMP.

Snapshots include planned/completed/pending/resolved/error shards, resolution
rate + Wilson bounds, total cost + cost/resolve, p50/p95 latency, delta versus
best single model, rank, and Pareto membership. Full arbitrary experiment
parameters stay in S3/Athena; Prometheus carries only bounded labels
(`run_id`, generation, benchmark, cell id, topology hash, and selected
low-cardinality axes).

Grafana provisions:

- Hypergrid Dynamics, an interactive Business Charts workspace for quality,
  cost, latency, search flow, live ranking, and confidence intervals;
- Hypergrid Leaderboard;
- Hypergrid Explorer (selectable topology/k/panel/commit axes);
- Quality/Cost Pareto;
- Generation & Search Coverage;
- Cell Drilldown;
- Learning Curves;
- operational Sweep Live, Fleet, and Fusion Internal dashboards.

`Hypergrid Dynamics` is driven entirely by the production
`hyperkit_cell_*` Prometheus snapshots. Its `run_id`, `benchmark`, and
multi-select `generation` variables update six linked views: a zoomable
quality/cost bubble explorer, parallel coordinates, topology-by-K heatmap,
generation-to-topology Sankey flow, animated cell ranking, and a Wilson
confidence-interval forest. Tooltips expose the cell, topology, generation,
K, panel, commit, rank, uplift, latency, and uncertainty metadata already
present in the bounded metric labels. The charts make no browser-side network
requests; Grafana supplies every value through provisioned Prometheus queries.

The Grafana image pins Business Charts (`volkovlabs-echarts-panel`) 7.2.5 for
Grafana 11.6. Local compose seed rules provide nine cells over three
generations and four topologies, with small periodic quality, cost, and latency
changes so dashboard refreshes exercise animated updates.

The controller keeps no database or in-memory authority. Restarting it
recomputes the same snapshots from S3, so live views recover after deployment,
Spot, or controller failures without special repair.

