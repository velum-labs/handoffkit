from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from typing import Annotated

import typer
import uvicorn
from fusionkit_core.clients import build_clients
from fusionkit_core.config import FusionMode, load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_evals.benchmark import BenchmarkRunner, load_jsonl_samples, write_jsonl_results
from fusionkit_evals.fusion_bench import (
    CommandHandoffKitExecutor,
    FusionBenchReport,
    FusionBenchRunner,
    build_fusion_bench_report,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    write_fusion_bench_html_report,
    write_fusion_bench_jsonl,
    write_fusion_bench_markdown_report,
    write_fusion_bench_report_jsonl,
)
from fusionkit_evals.pareto import load_points, write_pareto_report
from fusionkit_evals.tiny import (
    load_tiny_tasks,
    run_tiny_benchmark,
    write_tiny_benchmark_report,
    write_tiny_jsonl,
)
from fusionkit_server.app import create_app
from fusionkit_server.openai_endpoint import build_endpoint, serve_single_endpoint

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


@app.command("serve-endpoint")
def serve_endpoint(
    id: Annotated[str, typer.Option("--id", help="endpoint id exposed via /v1/models")],
    model: Annotated[str, typer.Option("--model", help="provider model name (e.g. gpt-5.5)")],
    port: Annotated[int, typer.Option("--port")],
    provider: Annotated[str, typer.Option("--provider")] = "openai",
    base_url: Annotated[
        str | None, typer.Option("--base-url", help="override the provider base URL")
    ] = None,
    api_key_env: Annotated[
        str | None, typer.Option("--api-key-env", help="env var holding the API key")
    ] = None,
    timeout_s: Annotated[float, typer.Option("--timeout-s")] = 120.0,
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
) -> None:
    """Front a single provider model as an OpenAI Chat Completions endpoint."""
    endpoint = build_endpoint(
        id=id,
        model=model,
        provider=provider,
        base_url=base_url,
        api_key_env=api_key_env,
        timeout_s=timeout_s,
    )
    serve_single_endpoint(endpoint, host=host, port=port)


@app.command()
def eval(
    config: Annotated[Path, typer.Option("--config", "-c")],
    samples: Annotated[Path, typer.Option("--samples", "-s")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    mode: FusionMode = "single",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
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
    clients = build_clients(fusion_config)
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


@app.command("fusion-bench")
def fusion_bench(
    config: Annotated[Path, typer.Option("--config", "-c")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    manifest: Annotated[Path | None, typer.Option("--manifest", "-m")] = None,
    run_root: Annotated[Path, typer.Option("--run-root")] = Path(".fusionkit/fusion-bench"),
    report_jsonl: Annotated[Path | None, typer.Option("--report-jsonl")] = None,
    report_markdown: Annotated[
        Path | None,
        typer.Option("--report", "-r", "--report-markdown"),
    ] = None,
    report_html: Annotated[Path | None, typer.Option("--report-html")] = None,
    handoff_command: Annotated[
        str | None,
        typer.Option(
            "--handoff-command",
            help=(
                "Optional HandoffKit-compatible command. It receives task JSON on stdin "
                "and emits model-fusion contract records on stdout."
            ),
        ),
    ] = None,
    handoff_timeout_s: Annotated[
        float,
        typer.Option("--handoff-timeout-s", min=1.0),
    ] = 300.0,
    mode: FusionMode = "panel",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = FusionEngine(config=fusion_config, clients=clients)
    runner = FusionBenchRunner(
        engine,
        run_root=run_root,
        config_id=config_id,
        mode=mode,
        model_versions={endpoint.id: endpoint.model for endpoint in fusion_config.endpoints},
        handoff_executor=(
            CommandHandoffKitExecutor(
                shlex.split(handoff_command),
                timeout_s=handoff_timeout_s,
            )
            if handoff_command is not None
            else None
        ),
    )
    tasks = load_benchmark_tasks(manifest) if manifest else load_benchmark_tasks()
    rows = asyncio.run(runner.run_tasks(tasks))
    write_fusion_bench_jsonl(output, rows)
    response: dict[str, int | str] = {"rows": len(rows), "output": str(output)}
    response.update(
        _write_fusion_bench_reports(
            build_fusion_bench_report(rows),
            report_jsonl=report_jsonl,
            report_markdown=report_markdown,
            report_html=report_html,
        )
    )
    typer.echo(json.dumps(response))


@app.command("fusion-bench-report")
def fusion_bench_report(
    input_path: Annotated[Path, typer.Option("--input", "-i")],
    report_jsonl: Annotated[Path | None, typer.Option("--jsonl")] = None,
    report_markdown: Annotated[Path | None, typer.Option("--markdown", "-m")] = None,
    report_html: Annotated[Path | None, typer.Option("--html")] = None,
) -> None:
    rows = load_fusion_bench_jsonl(input_path)
    report = build_fusion_bench_report(rows)
    response: dict[str, int | str] = {
        "rows": len(rows),
        "tasks": report.aggregate.total_tasks,
        "skipped": report.aggregate.skipped_tasks,
        "failed": report.aggregate.failed_tasks,
    }
    response.update(
        _write_fusion_bench_reports(
            report,
            report_jsonl=report_jsonl,
            report_markdown=report_markdown,
            report_html=report_html,
        )
    )
    typer.echo(json.dumps(response))


def _write_fusion_bench_reports(
    report: FusionBenchReport,
    *,
    report_jsonl: Path | None,
    report_markdown: Path | None,
    report_html: Path | None,
) -> dict[str, str]:
    outputs = {}
    if report_jsonl is not None:
        write_fusion_bench_report_jsonl(report_jsonl, report)
        outputs["report_jsonl"] = str(report_jsonl)
    if report_markdown is not None:
        write_fusion_bench_markdown_report(report_markdown, report)
        outputs["report_markdown"] = str(report_markdown)
    if report_html is not None:
        write_fusion_bench_html_report(report_html, report)
        outputs["report_html"] = str(report_html)
    return outputs
