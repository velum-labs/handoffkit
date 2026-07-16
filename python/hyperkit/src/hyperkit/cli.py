"""The ``hyperkit`` CLI: plan / status / collect / replay.

Own binary (not a ``fusionkit bench`` alias) -- hyperkit is a standalone
platform. Compute submission (``apply``) lives behind the ComputeBackend and is
added with the cloud backend; the offline commands here work today.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

import typer

import hyperkit.adapters  # noqa: F401  (registers built-in benchmark adapters)
import hyperkit.suts  # noqa: F401  (registers built-in SUTs)
from hyperkit.backends.s3 import S3ResultStore
from hyperkit.cloud.controller import main as controller_main
from hyperkit.core.aggregate import format_table
from hyperkit.core.experiments import load_experiment
from hyperkit.core.lock import load_lock
from hyperkit.core.models import TopologySpec
from hyperkit.core.store import ResultStore
from hyperkit.core.sweep import SweepEngine
from hyperkit.local_controller import run_local_controller
from hyperkit.replay import ReplayRow, replay_reports

app = typer.Typer(no_args_is_help=True, help="hyperkit experiment platform")


@app.command()
def plan(
    experiment: Annotated[Path, typer.Argument(help="experiment.py[:symbol] or matrix.yaml")],
    workdir: Annotated[Path, typer.Option(help="sweep working dir")] = Path(".hyperkit"),
    sweep_id: Annotated[
        str | None, typer.Option(help="sweep id (defaults to matrix id)")
    ] = None,
    max_vcpus: Annotated[int, typer.Option()] = 64,
    spend_ceiling_usd: Annotated[float | None, typer.Option()] = None,
) -> None:
    resolved = load_experiment(str(experiment))
    engine = SweepEngine(workdir)
    result = engine.plan(
        resolved,
        sweep_id=sweep_id,
        max_vcpus=max_vcpus,
        spend_ceiling_usd=spend_ceiling_usd,
    )
    summary = result.cells[0] if result.cells else {"cells": 0, "shards": 0}
    typer.echo(f"planned {summary['cells']} cells / {summary['shards']} shards -> {workdir}")


@app.command()
def extend(
    experiment: Annotated[Path, typer.Argument(help="experiment.py[:symbol] or matrix.yaml")],
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit"),
    from_results: Annotated[
        bool,
        typer.Option("--from-results", help="use Experiment.on_results instead of cells"),
    ] = False,
) -> None:
    """Re-materialize edited experiment code and append only genuinely new cells."""

    added = SweepEngine(workdir).extend(
        load_experiment(str(experiment)),
        from_results=from_results,
    )
    typer.echo(f"appended {len(added)} new cells (overlaps deduplicated)")


@app.command()
def apply(
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit"),
    backend: Annotated[str, typer.Option()] = "aws-batch",
    rung: Annotated[
        int | None,
        typer.Option(help="limit each cell to its first N instances (halving budget)"),
    ] = None,
    only: Annotated[
        str | None, typer.Option(help="glob over cell labels to submit")
    ] = None,
) -> None:
    """Submit missing shards only; safe to call repeatedly (resume semantics)."""

    count = SweepEngine(workdir, backend=backend).apply(backend, rung=rung, only=only)
    typer.echo(f"submitted {count} missing shards via {backend}")


@app.command()
def resume(
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit"),
    backend: Annotated[str, typer.Option()] = "aws-batch",
) -> None:
    """Retry only the exact cohort declared by earlier apply calls."""

    count = SweepEngine(workdir, backend=backend).resume(backend)
    typer.echo(f"resumed {count} missing shards via {backend} (frozen lock)")


@app.command()
def pull(
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit"),
    bucket: Annotated[
        str | None,
        typer.Option(help="S3 bucket (default: HYPERKIT_AWS_BUCKET / HYPERKIT_S3_BUCKET)"),
    ] = None,
    prefix: Annotated[str, typer.Option(help="S3 key prefix")] = "",
) -> None:
    """Mirror cloud ShardResults into the local store so status/collect and
    offline analysis see the same checkpoint the runners wrote to S3."""

    resolved_bucket = (
        bucket
        or os.environ.get("HYPERKIT_AWS_BUCKET")
        or os.environ.get("HYPERKIT_S3_BUCKET")
    )
    if not resolved_bucket:
        raise typer.BadParameter("provide --bucket or set HYPERKIT_AWS_BUCKET")
    lock = load_lock(workdir / "sweep.lock.json")
    remote = S3ResultStore(
        resolved_bucket, prefix=prefix or os.environ.get("HYPERKIT_S3_PREFIX", "")
    )
    local = ResultStore(workdir / "results")
    present = {
        result.shard_id: result
        for result in local.get_all(lock.sweep_id)
    }
    pulled = 0
    for result in remote.get_all(lock.sweep_id):
        existing = present.get(result.shard_id)
        if existing is None:
            local.put(lock.sweep_id, result)
            pulled += 1
        elif existing != result:
            raise RuntimeError(
                f"local and S3 checkpoints conflict for shard {result.shard_id}"
            )
    typer.echo(f"pulled {pulled} new results from s3://{resolved_bucket}")


@app.command()
def status(workdir: Annotated[Path, typer.Option()] = Path(".hyperkit")) -> None:
    engine = SweepEngine(workdir)
    s = engine.status()
    typer.echo(f"total={s['total']} done={s['done']} pending={s['pending']}")


@app.command()
def collect(workdir: Annotated[Path, typer.Option()] = Path(".hyperkit")) -> None:
    engine = SweepEngine(workdir)
    typer.echo(format_table(engine.collect()))


@app.command()
def controller() -> None:
    """Run the stateless S3/SQS hypergrid snapshot controller."""

    raise typer.Exit(controller_main())


@app.command("local-controller")
def local_controller(
    workdir: Annotated[
        list[Path], typer.Option(help="sweep workdir(s) to watch (repeatable)")
    ],
    poll: Annotated[float, typer.Option(help="poll interval seconds")] = 10.0,
    once: Annotated[bool, typer.Option("--once", help="one reconcile pass, then exit")] = False,
) -> None:
    """Publish live CellSnapshot gauges from local sweeps (filesystem twin of
    the cloud controller). Set OTEL_EXPORTER_OTLP_ENDPOINT to a Prometheus
    OTLP receiver, e.g. http://127.0.0.1:19090/api/v1/otlp."""

    raise typer.Exit(run_local_controller(list(workdir), poll_interval=poll, once=once))


@app.command("replay-swebench")
def replay_swebench(
    manifest: Annotated[Path, typer.Option(help="instance manifest (text list)")],
    report: Annotated[
        list[str],
        typer.Option(help="label=report.json (repeatable); label 'solo-*' marks a baseline"),
    ],
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit-replay"),
    sweep_id: Annotated[str, typer.Option()] = "replay",
) -> None:
    """Aggregate committed SWE-bench harness reports into a sweep table."""

    rows: list[ReplayRow] = []
    for spec in report:
        label, _, path = spec.partition("=")
        kind = "solo-model" if label.startswith("solo") else "fusionkit-serve"
        rows.append(
            ReplayRow(
                label=label,
                sut=TopologySpec(kind=kind, params={"label": label}),
                report_path=Path(path),
            )
        )
    run = replay_reports(
        workdir,
        sweep_id=sweep_id,
        benchmark="swebench_verified",
        manifest_ref=str(manifest),
        rows=rows,
    )
    typer.echo(format_table(run))


if __name__ == "__main__":  # pragma: no cover
    app()
