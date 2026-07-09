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

- `fusionkit-serve` is a `SystemUnderTest` entry-point;
- `TopologySpec` resolves to FusionKit's existing TypeScript
  `OperatorGraph`/`Scheduler` kernel;
- Fusion-specific metrics ship as a Grafana dashboard pack.

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
                    params={"workflow": "driver", "panel": ["terminus", "qwen3"], "k": k},
                ),
                benchmark="swebench_verified",
                instances=ctx.manifest("swebench_verified", "manifest.txt"),
            )
```

`hyperkit plan grid.py` evaluates the code once and freezes canonical cells
into `sweep.lock.json`. Shard identity is a hash of materialized SUT config,
benchmark, adapter version, instance, and dataset hash; runners never import the
experiment code.

Reload behavior is explicit:

- `hyperkit resume` uses the frozen lock (code ignored);
- `hyperkit extend grid.py` re-materializes edited code and appends only new
  cells; overlap deduplicates by content hash;
- removed cells are historical, never destructive; results remain queryable.

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
- always-on Grafana dashboards for sweep progress, fleet health, and
  FusionKit internals.

The S3 `ShardResult` is the checkpoint. Spot interruption or controller
restart loses at most in-flight shards; `resume` submits only the missing set.

