from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Annotated

import typer
import uvicorn
from fusionkit_core.clients import LocalModelClient
from fusionkit_core.config import FusionMode, load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_evals.benchmark import BenchmarkRunner, load_jsonl_samples, write_jsonl_results
from fusionkit_evals.pareto import load_points, write_pareto_report
from fusionkit_evals.tiny import (
    load_tiny_tasks,
    run_tiny_benchmark,
    write_tiny_benchmark_report,
    write_tiny_jsonl,
)
from fusionkit_server.app import create_app

app = typer.Typer(help="Local model fusion toolkit.")


@app.command()
def serve(
    config: Annotated[Path, typer.Option("--config", "-c")],
    host: str = "127.0.0.1",
    port: int = 8080,
) -> None:
    fusion_config = load_config(config)
    api = create_app(fusion_config)
    uvicorn.run(api, host=host, port=port)


@app.command()
def eval(
    config: Annotated[Path, typer.Option("--config", "-c")],
    samples: Annotated[Path, typer.Option("--samples", "-s")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    mode: FusionMode = "single",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = {
        endpoint.id: LocalModelClient(endpoint)
        for endpoint in fusion_config.endpoints
    }
    engine = FusionEngine(config=fusion_config, clients=clients)
    runner = BenchmarkRunner(engine)
    results = asyncio.run(runner.run_samples(load_jsonl_samples(samples), config_id, mode))
    write_jsonl_results(output, results)
    typer.echo(json.dumps({"results": len(results), "output": str(output)}))


@app.command()
def pareto(
    points: Annotated[Path, typer.Option("--points", "-p")],
    output: Annotated[Path, typer.Option("--output", "-o")],
) -> None:
    write_pareto_report(output, load_points(points))
    typer.echo(json.dumps({"output": str(output)}))


@app.command("tiny-bench")
def tiny_bench(
    config: Annotated[Path, typer.Option("--config", "-c")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    report: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    mode: FusionMode = "panel",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = {
        endpoint.id: LocalModelClient(endpoint)
        for endpoint in fusion_config.endpoints
    }
    engine = FusionEngine(config=fusion_config, clients=clients)
    results = asyncio.run(
        run_tiny_benchmark(
            engine,
            config_id=config_id,
            mode=mode,
            tasks=load_tiny_tasks(),
            model_versions={endpoint.id: endpoint.model for endpoint in fusion_config.endpoints},
        )
    )
    write_tiny_jsonl(output, results)
    response = {"results": len(results), "output": str(output)}
    if report is not None:
        write_tiny_benchmark_report(report, results)
        response["report"] = str(report)
    typer.echo(json.dumps(response))
