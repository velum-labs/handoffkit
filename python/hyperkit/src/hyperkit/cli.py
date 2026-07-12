"""The ``hyperkit`` CLI: plan / status / collect / replay.

Own binary (not a ``fusionkit bench`` alias) -- hyperkit is a standalone
platform. Compute submission (``apply``) lives behind the ComputeBackend and is
added with the cloud backend; the offline commands here work today.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

import hyperkit.adapters  # noqa: F401  (registers built-in benchmark adapters)
import hyperkit.suts  # noqa: F401  (registers built-in SUTs)
from hyperkit.cloud.controller import main as controller_main
from hyperkit.local_controller import run_local_controller
from hyperkit.core.aggregate import format_table
from hyperkit.core.experiments import load_experiment
from hyperkit.core.models import TopologySpec
from hyperkit.core.sweep import SweepEngine
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
) -> None:
    """Submit missing shards only; safe to call repeatedly (resume semantics)."""

    count = SweepEngine(workdir, backend=backend).apply(backend)
    typer.echo(f"submitted {count} missing shards via {backend}")


@app.command()
def resume(
    workdir: Annotated[Path, typer.Option()] = Path(".hyperkit"),
    backend: Annotated[str, typer.Option()] = "aws-batch",
) -> None:
    """Alias for apply-from-lock: experiment code is not re-executed."""

    count = SweepEngine(workdir, backend=backend).apply(backend)
    typer.echo(f"resumed {count} missing shards via {backend} (frozen lock)")


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
