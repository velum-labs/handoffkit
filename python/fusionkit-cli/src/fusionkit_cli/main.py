from __future__ import annotations

import asyncio
import json
import os
import shlex
from pathlib import Path
from typing import Annotated, cast

import typer
import uvicorn
from fusionkit_core.clients import build_clients
from fusionkit_core.config import FusionMode, load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.prompts import SYSTEM_PROMPT_DEFAULTS
from fusionkit_evals.bench_history import BenchRunRecord, append_run, drift_vs_previous
from fusionkit_evals.benchmark import BenchmarkRunner, load_jsonl_samples, write_jsonl_results
from fusionkit_evals.benchmark_panel import get_benchmark_panel
from fusionkit_evals.candidate_bank import (
    PreparedTask,
    bank_signature,
    build_candidate_bank,
    load_bank,
    save_bank,
)
from fusionkit_evals.fusion_bench import (
    CommandHandoffKitExecutor,
    FusionBenchReport,
    FusionBenchRunner,
    build_fusion_bench_report,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    write_fusion_bench_jsonl,
)
from fusionkit_evals.fusion_reports import (
    write_fusion_bench_html_report,
    write_fusion_bench_markdown_report,
    write_fusion_bench_report_jsonl,
)
from fusionkit_evals.livecodebench_data import (
    LCB_PROMPT_SUFFIX,
    load_manifest,
    load_problems,
    prepare_tasks,
)
from fusionkit_evals.pareto import load_points, write_pareto_report
from fusionkit_evals.prompt_tuning import (
    LLMProposer,
    TunableRole,
    TunerRuntime,
    TuningResult,
    optimize,
    select_decision_tasks,
    split_dev_val,
)
from fusionkit_evals.public_bench import (
    PUBLIC_BENCHMARK_INFO,
    PUBLIC_BENCHMARK_SUITES,
    CommandExternalBenchmarkExecutor,
    ExternalBenchmarkRequest,
    PublicBenchmarkSuite,
    baselines_for,
    run_public_benchmark,
    write_external_runs_jsonl,
)
from fusionkit_evals.public_bench_report import (
    build_benchmark_comparison,
    write_benchmark_comparison_markdown,
)
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox
from fusionkit_evals.tiny import (
    load_tiny_tasks,
    run_tiny_benchmark,
    write_tiny_benchmark_report,
    write_tiny_jsonl,
)
from fusionkit_server.app import create_app
from fusionkit_server.openai_endpoint import build_endpoint, serve_single_endpoint

app = typer.Typer(help="Local model fusion toolkit.")

prompts_app = typer.Typer(help="Inspect and export the built-in fusion prompts.")
app.add_typer(prompts_app, name="prompts")


@prompts_app.command("dump")
def prompts_dump(
    dir: Annotated[
        Path | None,
        typer.Option("--dir", help="write each default prompt to <dir>/<id>.md instead of stdout"),
    ] = None,
) -> None:
    """Emit the built-in system prompts so a consumer can scaffold editable overrides.

    With no options this prints a JSON object mapping each prompt id (e.g.
    ``judge``, ``trajectory-step``) to its default text. With ``--dir`` it writes
    one ``<id>.md`` file per prompt. This keeps the CLI's scaffolded
    ``.fusionkit/prompts`` defaults in lockstep with this package's source.
    """
    if dir is not None:
        dir.mkdir(parents=True, exist_ok=True)
        for prompt_id, text in SYSTEM_PROMPT_DEFAULTS.items():
            (dir / f"{prompt_id}.md").write_text(text + "\n")
        typer.echo(json.dumps({"dir": str(dir), "count": len(SYSTEM_PROMPT_DEFAULTS)}))
        return
    typer.echo(json.dumps(SYSTEM_PROMPT_DEFAULTS, indent=2))


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


@app.command("eval")
def run_eval(
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


@app.command("public-bench")
def public_bench(
    suite: Annotated[str, typer.Option("--suite", help="public benchmark suite to run")],
    panel: Annotated[
        str,
        typer.Option("--panel", help="benchmark panel id (e.g. decorrelated-peers)"),
    ] = "decorrelated-peers",
    gateway_base_url: Annotated[
        str, typer.Option("--gateway-base-url")
    ] = "http://127.0.0.1:8080",
    gateway_model: Annotated[
        str | None,
        typer.Option("--gateway-model", help="gateway model alias (defaults per suite)"),
    ] = None,
    runner_command: Annotated[
        str | None,
        typer.Option(
            "--runner-command",
            help=(
                "External runner adapter. Receives the request JSON on stdin and emits a "
                "normalized run envelope on stdout. Omit to produce an 'unavailable' report."
            ),
        ),
    ] = None,
    subset: Annotated[
        int | None,
        typer.Option("--subset", min=1, help="run only the first N tasks (subset-first)"),
    ] = None,
    runner_timeout_s: Annotated[float, typer.Option("--runner-timeout-s", min=1.0)] = 1800.0,
    output: Annotated[Path | None, typer.Option("--output", "-o")] = None,
    report_markdown: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    ledger: Annotated[
        Path | None,
        typer.Option("--ledger", help="append the run to a history ledger and report drift"),
    ] = None,
) -> None:
    """Run a public coding benchmark against the gateway and compare to leaderboards."""

    resolved_suite = _resolve_public_suite(suite)
    info = PUBLIC_BENCHMARK_INFO[resolved_suite]
    benchmark_panel = get_benchmark_panel(panel)
    request = ExternalBenchmarkRequest(
        suite=resolved_suite,
        mount_mode=info.mount_mode,
        gateway_base_url=gateway_base_url,
        gateway_model=gateway_model or info.default_gateway_model,
        panel_id=benchmark_panel.panel_id,
        subset=subset,
    )
    executor = (
        CommandExternalBenchmarkExecutor(
            shlex.split(runner_command),
            timeout_s=runner_timeout_s,
        )
        if runner_command is not None
        else None
    )
    run = asyncio.run(run_public_benchmark(request, executor))
    comparison = build_benchmark_comparison(run, benchmark_panel)
    response: dict[str, int | str | float | None] = {
        "suite": run.suite,
        "panel": run.panel_id,
        "availability": run.availability,
        "fusion_score": comparison.fusion_score,
        "fusion_ci": _fmt_ci(comparison.fusion_ci_low, comparison.fusion_ci_high),
        "measured_oracle": comparison.measured_oracle,
        "measured_regret": comparison.measured_regret,
        "oracle_headroom": comparison.oracle_headroom,
        "lopsided_panel": int(comparison.lopsided),
        "infra_error_tasks": run.infra_error_tasks,
        "excluded_tasks": run.excluded_tasks,
    }
    if output is not None:
        write_external_runs_jsonl(output, [run])
        response["output"] = str(output)
    if report_markdown is not None:
        write_benchmark_comparison_markdown(report_markdown, comparison)
        response["report"] = str(report_markdown)
    if ledger is not None:
        record = BenchRunRecord(
            suite=run.suite,
            panel_id=run.panel_id,
            resolved_tasks=run.resolved_tasks,
            score=comparison.fusion_score,
            ci_low=comparison.fusion_ci_low,
            ci_high=comparison.fusion_ci_high,
            cache_signature=_optional_str(run.raw_metadata.get("cache_signature")),
            repo_sha=_optional_str(run.provenance.get("repo_sha")),
        )
        drift = drift_vs_previous(ledger, record)
        append_run(ledger, record)
        response["ledger"] = str(ledger)
        if drift is not None:
            response["drift_delta"] = drift.delta
            response["regressed"] = int(drift.regressed)
    typer.echo(json.dumps(response))


def _fmt_ci(low: float | None, high: float | None) -> str | None:
    if low is None or high is None:
        return None
    return f"[{low:.4f}, {high:.4f}]"


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


@app.command("public-bench-baselines")
def public_bench_baselines(
    suite: Annotated[
        str | None,
        typer.Option("--suite", help="limit to one suite; omit for all suites"),
    ] = None,
) -> None:
    """Print the published leaderboard baselines used for comparison."""

    suites = (PUBLIC_BENCHMARK_SUITES if suite is None else (_resolve_public_suite(suite),))
    payload = {
        target: [baseline.model_dump(mode="json") for baseline in baselines_for(target)]
        for target in suites
    }
    typer.echo(json.dumps(payload, indent=2))


_ROLE_PROMPT_FILE = {
    "judge_system": "judge.md",
    "synthesizer_system": "synthesizer.md",
}


@app.command("tune-prompts")
def tune_prompts(
    config: Annotated[Path, typer.Option("--config", "-c", help="panel FusionConfig YAML")],
    bank: Annotated[
        Path, typer.Option("--bank", help="candidate bank path (built if missing)")
    ] = Path(".fusionkit/tuning/bank.json"),
    role: Annotated[str, typer.Option("--role", help="prompt role to tune")] = "synthesizer_system",
    subset: Annotated[int, typer.Option("--subset", min=1)] = 40,
    bank_max_tests: Annotated[
        int, typer.Option("--bank-max-tests", help="cap tests/task when building the bank (0=all)")
    ] = 0,
    optimizer_model: Annotated[
        str | None, typer.Option("--optimizer-model", help="endpoint id (default: judge)")
    ] = None,
    max_iterations: Annotated[int, typer.Option("--max-iterations", min=1)] = 8,
    patience: Annotated[int, typer.Option("--patience", min=1)] = 3,
    val_fraction: Annotated[float, typer.Option("--val-fraction", min=0.1, max=0.9)] = 0.4,
    seed: Annotated[int, typer.Option("--seed")] = 0,
    test_timeout_s: Annotated[float, typer.Option("--test-timeout-s", min=1.0)] = 8.0,
    concurrency: Annotated[int, typer.Option("--concurrency", min=1)] = 4,
    prompts_out: Annotated[Path, typer.Option("--prompts-out")] = Path(".fusionkit/prompts"),
    cache_dir: Annotated[Path, typer.Option("--cache-dir")] = Path(".fusionkit/tuning/cache"),
    report: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    ledger: Annotated[Path | None, typer.Option("--ledger")] = None,
) -> None:
    """Automated LLM-driven tuning of judge/synth prompts over a frozen bank."""

    if role not in _ROLE_PROMPT_FILE:
        raise typer.BadParameter(f"role must be one of {sorted(_ROLE_PROMPT_FILE)}")
    resolved_role = cast(TunableRole, role)
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = FusionEngine(config=fusion_config, clients=clients)
    sandbox = build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local")))

    if bank.exists():
        candidate_bank = load_bank(bank)
    else:
        problems = load_problems(
            subset,
            version=os.environ.get("LCB_VERSION", "release_v6"),
            min_date=os.environ.get("LCB_MIN_DATE", "2025-01-01"),
            manifest=load_manifest(os.environ.get("LCB_MANIFEST")),
        )
        prepared = [
            PreparedTask(**task) for task in prepare_tasks(problems, max_tests=bank_max_tests)
        ]
        signature = bank_signature(engine, prompt_suffix=LCB_PROMPT_SUFFIX)
        candidate_bank = asyncio.run(
            build_candidate_bank(
                engine,
                sandbox,
                prepared,
                signature=signature,
                test_timeout_s=test_timeout_s,
                concurrency=concurrency,
            )
        )
        save_bank(bank, candidate_bank)

    decision = select_decision_tasks(candidate_bank)
    if len(decision) < 2:
        typer.echo(
            json.dumps(
                {
                    "error": "not enough decision tasks to tune",
                    "decision_tasks": len(decision),
                    "total_tasks": len(candidate_bank.tasks),
                }
            )
        )
        raise typer.Exit(code=1)
    split = split_dev_val(decision, val_fraction=val_fraction, seed=seed)
    by_id = {task.task_id: task for task in candidate_bank.tasks}
    dev_tasks = [by_id[task_id] for task_id in split.dev]
    val_tasks = [by_id[task_id] for task_id in split.val]

    runtime = TunerRuntime(
        clients=clients,
        judge_id=fusion_config.resolved_judge_model,
        synth_id=fusion_config.resolved_synthesizer_model,
        bank_signature=candidate_bank.signature,
        sandbox=sandbox,
        cache_dir=cache_dir,
        judge_sampling=fusion_config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=fusion_config.sampling,
        test_timeout_s=test_timeout_s,
        concurrency=concurrency,
    )
    proposer = LLMProposer(
        clients[optimizer_model or fusion_config.resolved_judge_model],
        fusion_config.sampling,
    )
    result = asyncio.run(
        optimize(
            runtime,
            dev_tasks=dev_tasks,
            val_tasks=val_tasks,
            proposer=proposer,
            role=resolved_role,
            max_iterations=max_iterations,
            patience=patience,
        )
    )

    tuned_prompt = result.best_variant.role_text(resolved_role)
    response: dict[str, object] = {
        "role": result.role,
        "decision_tasks": len(decision),
        "dev": len(dev_tasks),
        "val": len(val_tasks),
        "baseline_dev": result.baseline_dev.score,
        "best_dev": result.best_dev.score,
        "baseline_val": result.baseline_val.score,
        "best_val": result.best_val.score,
        "val_ci": _fmt_ci(result.best_val.ci_low, result.best_val.ci_high),
        "accepted_trials": sum(1 for trial in result.trials if trial.accepted),
        "trials": len(result.trials),
        "improved": result.best_val.score > result.baseline_val.score,
    }
    if tuned_prompt is not None and result.best_val.score > result.baseline_val.score:
        prompts_out.mkdir(parents=True, exist_ok=True)
        out_file = prompts_out / _ROLE_PROMPT_FILE[role]
        out_file.write_text(tuned_prompt + "\n", encoding="utf-8")
        response["prompts_out"] = str(out_file)
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(_format_tuning_report(result), encoding="utf-8")
        response["report"] = str(report)
    if ledger is not None:
        append_run(
            ledger,
            BenchRunRecord(
                suite="prompt-tuning",
                panel_id=result.role,
                resolved_tasks=len(val_tasks),
                score=result.best_val.score,
                ci_low=result.best_val.ci_low,
                ci_high=result.best_val.ci_high,
            ),
        )
        response["ledger"] = str(ledger)
    typer.echo(json.dumps(response))


def _format_tuning_report(result: TuningResult) -> str:
    lines = [
        "# Prompt Tuning Report",
        "",
        f"- Role: {result.role}",
        f"- Baseline dev: {result.baseline_dev.score:.4f} -> best dev: {result.best_dev.score:.4f}",
        f"- Baseline val: {result.baseline_val.score:.4f} -> best val: {result.best_val.score:.4f} "
        f"(95% CI [{result.best_val.ci_low:.4f}, {result.best_val.ci_high:.4f}])",
        f"- Promoted: {result.best_val.score > result.baseline_val.score}",
        "",
        "## Trials (dev)",
        "",
        "| Iter | dev score | wins | losses | accepted |",
        "| ---: | ---: | ---: | ---: | :--: |",
    ]
    for trial in result.trials:
        lines.append(
            f"| {trial.iteration} | {trial.dev_score:.4f} | {trial.wins} | {trial.losses} | "
            f"{'yes' if trial.accepted else 'no'} |"
        )
    lines.append("")
    return "\n".join(lines)


def _resolve_public_suite(suite: str) -> PublicBenchmarkSuite:
    if suite not in PUBLIC_BENCHMARK_SUITES:
        known = ", ".join(PUBLIC_BENCHMARK_SUITES)
        raise typer.BadParameter(f"unknown suite {suite!r}; choose one of: {known}")
    return cast(PublicBenchmarkSuite, suite)


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
