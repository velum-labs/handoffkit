from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
from pathlib import Path
from typing import Annotated, cast

import typer
from fusionkit_core.clients import build_clients
from fusionkit_core.config import FusionMode, load_config
from fusionkit_core.fusion import FusionEngine

from fusionkit_evals.bench_history import BenchRunRecord, append_run, drift_vs_previous
from fusionkit_evals.benchmark import BenchmarkRunner, load_jsonl_samples, write_jsonl_results
from fusionkit_evals.benchmark_panel import get_benchmark_panel
from fusionkit_evals.candidate_bank import (
    CandidateBank,
    PreparedTask,
    bank_signature,
    build_candidate_bank,
    load_bank,
    save_bank,
)
from fusionkit_evals.cli_shared import benchmark_kernel
from fusionkit_evals.fusion_bench import (
    CommandHandoffKitExecutor,
    FusionBenchReport,
    FusionBenchRunner,
    build_fusion_bench_report,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    write_fusion_bench_jsonl,
)
from fusionkit_evals.fusion_hillclimb import (
    ClimbDiagnosis,
    ClimbResult,
    TargetCheck,
    best_single_baseline,
    check_target,
    diagnose_bank,
    run_climb,
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
from fusionkit_evals.polyglot import (
    build_polyglot_bank,
    load_polyglot_exercises,
    polyglot_verifier,
)
from fusionkit_evals.prompt_tuning import (
    LLMProposer,
    PromptEval,
    TunableRole,
    TunerRuntime,
    TuningResult,
    evaluate_variant,
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
from fusionkit_evals.registry import BENCHMARK_PANEL_PRESETS, FUSION_GATEWAY_DEFAULT_BASE_URL
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox
from fusionkit_evals.tiny import (
    load_tiny_tasks,
    run_tiny_benchmark,
    write_tiny_benchmark_report,
    write_tiny_jsonl,
)

DEFAULT_PUBLIC_BENCH_PANEL = next(iter(BENCHMARK_PANEL_PRESETS))
bench_app = typer.Typer(help="Benchmark, tune, and report on FusionKit fusion quality.")

def run_eval(
    config: Annotated[Path, typer.Option("--config", "-c")],
    samples: Annotated[Path, typer.Option("--samples", "-s")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    mode: FusionMode = "single",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = cast(
        FusionEngine,
        benchmark_kernel(fusion_config, clients, Path(".fusionkit/python-kernel-runs/eval")),
    )
    runner = BenchmarkRunner(engine)
    results = asyncio.run(runner.run_samples(load_jsonl_samples(samples), config_id, mode))
    write_jsonl_results(output, results)
    typer.echo(json.dumps({"results": len(results), "output": str(output)}))


def pareto(
    points: Annotated[Path, typer.Option("--points", "-p")],
    output: Annotated[Path, typer.Option("--output", "-o")],
) -> None:
    write_pareto_report(output, load_points(points))
    typer.echo(json.dumps({"output": str(output)}))


def tiny_bench(
    config: Annotated[Path, typer.Option("--config", "-c")],
    output: Annotated[Path, typer.Option("--output", "-o")],
    report: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    mode: FusionMode = "panel",
    config_id: str = "local",
) -> None:
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = cast(
        FusionEngine,
        benchmark_kernel(
            fusion_config, clients, Path(".fusionkit/python-kernel-runs/tiny-bench")
        ),
    )
    results = asyncio.run(
        run_tiny_benchmark(
            engine,
            config_id=config_id,
            mode=mode,
            tasks=load_tiny_tasks(),
            model_versions={
                model_id: model_id for model_id in fusion_config.routekit_model_ids
            },
        )
    )
    write_tiny_jsonl(output, results)
    response = {"results": len(results), "output": str(output)}
    if report is not None:
        write_tiny_benchmark_report(report, results)
        response["report"] = str(report)
    typer.echo(json.dumps(response))


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
    engine = cast(FusionEngine, benchmark_kernel(fusion_config, clients, run_root / "kernel"))
    runner = FusionBenchRunner(
        engine,
        run_root=run_root,
        config_id=config_id,
        mode=mode,
        model_versions={
            model_id: model_id for model_id in fusion_config.routekit_model_ids
        },
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


def public_bench(
    suite: Annotated[str, typer.Option("--suite", help="public benchmark suite to run")],
    panel: Annotated[
        str,
        typer.Option("--panel", help="benchmark panel id (e.g. decorrelated-peers)"),
    ] = DEFAULT_PUBLIC_BENCH_PANEL,
    gateway_base_url: Annotated[
        str, typer.Option("--gateway-base-url")
    ] = FUSION_GATEWAY_DEFAULT_BASE_URL,
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
        str | None,
        typer.Option("--optimizer-model", help="namespaced RouteKit model id (default: judge)"),
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
    engine = cast(FusionEngine, benchmark_kernel(fusion_config, clients, cache_dir / "kernel-runs"))
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


def fusion_hillclimb(
    config: Annotated[Path, typer.Option("--config", "-c", help="panel FusionConfig YAML")],
    bank: Annotated[
        Path, typer.Option("--bank", help="candidate bank path (built if missing)")
    ] = Path(".fusionkit/hillclimb/bank.json"),
    role: Annotated[
        str, typer.Option("--role", help="prompt role to climb")
    ] = "synthesizer_system",
    subset: Annotated[int, typer.Option("--subset", min=1)] = 120,
    bank_max_tests: Annotated[int, typer.Option("--bank-max-tests")] = 0,
    optimizer_model: Annotated[str | None, typer.Option("--optimizer-model")] = None,
    max_iterations: Annotated[
        int, typer.Option("--max-iterations", min=0, help="0 = baseline/diagnose only")
    ] = 8,
    patience: Annotated[int, typer.Option("--patience", min=1)] = 3,
    val_fraction: Annotated[float, typer.Option("--val-fraction", min=0.1, max=0.9)] = 0.4,
    test_fraction: Annotated[
        float, typer.Option("--test-fraction", min=0.1, max=0.8, help="locked held-out test split")
    ] = 0.34,
    seed: Annotated[int, typer.Option("--seed")] = 0,
    test_timeout_s: Annotated[float, typer.Option("--test-timeout-s", min=1.0)] = 8.0,
    concurrency: Annotated[int, typer.Option("--concurrency", min=1)] = 4,
    budget_usd: Annotated[
        float, typer.Option("--budget-usd", help="advisory cap recorded in the report")
    ] = 100.0,
    prompts_out: Annotated[Path, typer.Option("--prompts-out")] = Path(".fusionkit/prompts"),
    cache_dir: Annotated[Path, typer.Option("--cache-dir")] = Path(".fusionkit/hillclimb/cache"),
    report: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    ledger: Annotated[Path | None, typer.Option("--ledger")] = None,
) -> None:
    """Hill-climb judge/synth prompts until the fused compound beats the best single model.

    Diagnoses fusion headroom on a frozen candidate bank, hill-climbs the prompt for
    ``role`` over the dev/val splits (McNemar-gated), then reports whether the fused
    compound beats the best single panel member on a LOCKED held-out test split
    (evaluated once). Tier-1 of the self-healing loop; Tier-2/3 are driven by the
    `fusion-hillclimb` skill, which calls this to re-measure after each change.
    """
    if role not in _ROLE_PROMPT_FILE:
        raise typer.BadParameter(f"role must be one of {sorted(_ROLE_PROMPT_FILE)}")
    resolved_role = cast(TunableRole, role)
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = cast(FusionEngine, benchmark_kernel(fusion_config, clients, cache_dir / "kernel-runs"))
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

    diagnosis = diagnose_bank(candidate_bank)
    decision = select_decision_tasks(candidate_bank)
    if len(decision) < 4:
        typer.echo(
            json.dumps(
                {
                    "error": "not enough decision tasks to climb",
                    "decision_tasks": len(decision),
                    "total_tasks": len(candidate_bank.tasks),
                    "diagnosis": diagnosis.model_dump(),
                }
            )
        )
        raise typer.Exit(code=1)

    # Reserve a locked test split from the decision tasks, evaluated once at the end.
    holdout = split_dev_val(decision, val_fraction=test_fraction, seed=seed)
    by_id = {task.task_id: task for task in candidate_bank.tasks}
    train_tasks = [by_id[task_id] for task_id in holdout.dev]
    test_tasks = [by_id[task_id] for task_id in holdout.val]
    if len(train_tasks) < 2 or len(test_tasks) < 1:
        typer.echo(
            json.dumps(
                {"error": "split too small", "train": len(train_tasks), "test": len(test_tasks)}
            )
        )
        raise typer.Exit(code=1)
    train_bank = CandidateBank(
        signature=candidate_bank.signature,
        panel_models=candidate_bank.panel_models,
        tasks=train_tasks,
    )

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

    async def _run() -> tuple[ClimbResult, PromptEval]:
        climb = await run_climb(
            runtime,
            train_bank,
            proposer=proposer,
            role=resolved_role,
            val_fraction=val_fraction,
            seed=seed,
            max_iterations=max_iterations,
            patience=patience,
        )
        fused = await evaluate_variant(runtime, climb.tuning.best_variant, test_tasks)
        return climb, fused

    result, fused_test = asyncio.run(_run())
    best_single_test = best_single_baseline(
        candidate_bank, task_ids=[task.task_id for task in test_tasks]
    )
    target_test = check_target(best_single_test, fused_test.passes)

    tuned_prompt = result.best_prompt
    response: dict[str, object] = {
        "role": result.role,
        "decision_tasks": len(decision),
        "train": len(train_tasks),
        "test": len(test_tasks),
        "best_single_model": diagnosis.best_single_model,
        "oracle_ceiling": diagnosis.oracle_ceiling,
        "oracle_headroom": diagnosis.oracle_headroom,
        "lopsided": diagnosis.lopsided,
        "val_fused_rate": result.target.fused_rate,
        "val_best_single_rate": result.target.best_single_rate,
        "val_beats_best_single": result.target.beats_best_single,
        "test_fused_rate": target_test.fused_rate,
        "test_best_single_rate": target_test.best_single_rate,
        "test_uplift": target_test.uplift,
        "test_mcnemar_wins": target_test.mcnemar.wins,
        "test_mcnemar_losses": target_test.mcnemar.losses,
        "test_significant": target_test.mcnemar.significant,
        "compound_beats_best_single": target_test.beats_best_single,
        "budget_usd": budget_usd,
    }
    # Promote the tuned prompt only if it makes the compound beat the best single on
    # the LOCKED test split (the honest, overfitting-resistant signal).
    if tuned_prompt is not None and target_test.uplift > 0:
        prompts_out.mkdir(parents=True, exist_ok=True)
        out_file = prompts_out / _ROLE_PROMPT_FILE[role]
        out_file.write_text(tuned_prompt + "\n", encoding="utf-8")
        response["prompts_out"] = str(out_file)
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(
            _format_hillclimb_report(result, diagnosis, target_test, len(test_tasks), budget_usd),
            encoding="utf-8",
        )
        response["report"] = str(report)
    if ledger is not None:
        append_run(
            ledger,
            BenchRunRecord(
                suite="fusion-hillclimb",
                panel_id=result.role,
                resolved_tasks=len(test_tasks),
                score=target_test.fused_rate,
            ),
        )
        response["ledger"] = str(ledger)
    typer.echo(json.dumps(response))


def fusion_hillclimb_polyglot(
    config: Annotated[Path, typer.Option("--config", "-c", help="panel FusionConfig YAML")],
    bank: Annotated[Path, typer.Option("--bank")] = Path(".fusionkit/hillclimb/polyglot-bank.json"),
    role: Annotated[
        str, typer.Option("--role", help="prompt role to climb")
    ] = "synthesizer_system",
    languages: Annotated[str, typer.Option("--languages")] = "python,go,rust",
    subset: Annotated[int, typer.Option("--subset", min=1)] = 103,
    polyglot_root: Annotated[Path | None, typer.Option("--polyglot-root")] = None,
    optimizer_model: Annotated[str | None, typer.Option("--optimizer-model")] = None,
    max_iterations: Annotated[int, typer.Option("--max-iterations", min=0)] = 8,
    patience: Annotated[int, typer.Option("--patience", min=1)] = 3,
    val_fraction: Annotated[float, typer.Option("--val-fraction", min=0.1, max=0.9)] = 0.4,
    test_fraction: Annotated[float, typer.Option("--test-fraction", min=0.1, max=0.8)] = 0.34,
    seed: Annotated[int, typer.Option("--seed")] = 0,
    timeout_s: Annotated[float, typer.Option("--timeout-s", min=1.0)] = 120.0,
    concurrency: Annotated[int, typer.Option("--concurrency", min=1)] = 3,
    budget_usd: Annotated[float, typer.Option("--budget-usd")] = 100.0,
    prompts_out: Annotated[Path, typer.Option("--prompts-out")] = Path(".fusionkit/prompts"),
    cache_dir: Annotated[
        Path, typer.Option("--cache-dir")
    ] = Path(".fusionkit/hillclimb/poly-cache"),
    report: Annotated[Path | None, typer.Option("--report", "-r")] = None,
    ledger: Annotated[Path | None, typer.Option("--ledger")] = None,
) -> None:
    """Hill-climb the synthesizer on Aider-polyglot until the compound beats the best single.

    Builds a frozen polyglot candidate bank (panel candidates scored by the real
    per-language test suites), then climbs the prompt for ``role`` with a
    polyglot-aware replay verifier, McNemar-gated, reporting the locked-test result.
    """
    if role not in _ROLE_PROMPT_FILE:
        raise typer.BadParameter(f"role must be one of {sorted(_ROLE_PROMPT_FILE)}")
    resolved_role = cast(TunableRole, role)
    language_list = [item.strip() for item in languages.split(",") if item.strip()]
    root = polyglot_root or (Path.home() / ".cache" / "fusionkit-bench" / "polyglot")
    fusion_config = load_config(config)
    clients = build_clients(fusion_config)
    engine = cast(FusionEngine, benchmark_kernel(fusion_config, clients, cache_dir / "kernel-runs"))
    sandbox = build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local")))

    # task_id -> exercise (needed by the replay verifier), rebuilt whether or not
    # the bank is reloaded from disk.
    all_exercises = load_polyglot_exercises(root, languages=language_list)
    exercise_map = {exercise.task_id: exercise for exercise in all_exercises}

    if bank.exists():
        candidate_bank = load_bank(bank)
    else:
        exercises = load_polyglot_exercises(root, languages=language_list, subset=subset)
        models_sig = sorted(fusion_config.routekit_model_ids)
        signature = hashlib.sha256(
            json.dumps(
                {
                "models": models_sig,
                    "panel": sorted(fusion_config.panel_models),
                    "languages": sorted(language_list),
                    "subset": subset,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()[:16]
        candidate_bank, _ = asyncio.run(
            build_polyglot_bank(
                engine,
                exercises,
                signature=signature,
                timeout_s=timeout_s,
                concurrency=concurrency,
                cache_dir=bank.parent / "poly-bank-cache",
            )
        )
        save_bank(bank, candidate_bank)

    diagnosis = diagnose_bank(candidate_bank)
    decision = select_decision_tasks(candidate_bank)
    if len(decision) < 4:
        typer.echo(
            json.dumps(
                {
                    "error": "not enough decision tasks to climb",
                    "decision_tasks": len(decision),
                    "total_tasks": len(candidate_bank.tasks),
                    "diagnosis": diagnosis.model_dump(),
                }
            )
        )
        raise typer.Exit(code=1)

    holdout = split_dev_val(decision, val_fraction=test_fraction, seed=seed)
    by_id = {task.task_id: task for task in candidate_bank.tasks}
    train_tasks = [by_id[task_id] for task_id in holdout.dev]
    test_tasks = [by_id[task_id] for task_id in holdout.val]
    train_bank = CandidateBank(
        signature=candidate_bank.signature,
        panel_models=candidate_bank.panel_models,
        tasks=train_tasks,
    )

    verifier = polyglot_verifier(exercise_map, timeout_s=timeout_s)
    runtime = TunerRuntime(
        clients=clients,
        judge_id=fusion_config.resolved_judge_model,
        synth_id=fusion_config.resolved_synthesizer_model,
        bank_signature=candidate_bank.signature,
        sandbox=sandbox,
        cache_dir=cache_dir,
        judge_sampling=fusion_config.sampling.model_copy(update={"temperature": 0.0}),
        synth_sampling=fusion_config.sampling,
        test_timeout_s=timeout_s,
        concurrency=concurrency,
        verifier=verifier,
    )
    proposer = LLMProposer(
        clients[optimizer_model or fusion_config.resolved_judge_model],
        fusion_config.sampling,
    )

    async def _run() -> tuple[ClimbResult, PromptEval]:
        climb = await run_climb(
            runtime,
            train_bank,
            proposer=proposer,
            role=resolved_role,
            val_fraction=val_fraction,
            seed=seed,
            max_iterations=max_iterations,
            patience=patience,
        )
        fused = await evaluate_variant(runtime, climb.tuning.best_variant, test_tasks)
        return climb, fused

    result, fused_test = asyncio.run(_run())
    best_single_test = best_single_baseline(
        candidate_bank, task_ids=[task.task_id for task in test_tasks]
    )
    target_test = check_target(best_single_test, fused_test.passes)

    tuned_prompt = result.best_prompt
    response: dict[str, object] = {
        "suite": "aider-polyglot",
        "role": result.role,
        "decision_tasks": len(decision),
        "train": len(train_tasks),
        "test": len(test_tasks),
        "best_single_model": diagnosis.best_single_model,
        "oracle_ceiling": diagnosis.oracle_ceiling,
        "oracle_headroom": diagnosis.oracle_headroom,
        "test_fused_rate": target_test.fused_rate,
        "test_best_single_rate": target_test.best_single_rate,
        "test_uplift": target_test.uplift,
        "test_significant": target_test.mcnemar.significant,
        "compound_beats_best_single": target_test.beats_best_single,
        "budget_usd": budget_usd,
    }
    if tuned_prompt is not None and target_test.uplift > 0:
        prompts_out.mkdir(parents=True, exist_ok=True)
        out_file = prompts_out / _ROLE_PROMPT_FILE[role]
        out_file.write_text(tuned_prompt + "\n", encoding="utf-8")
        response["prompts_out"] = str(out_file)
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(
            _format_hillclimb_report(result, diagnosis, target_test, len(test_tasks), budget_usd),
            encoding="utf-8",
        )
        response["report"] = str(report)
    if ledger is not None:
        append_run(
            ledger,
            BenchRunRecord(
                suite="fusion-hillclimb-polyglot",
                panel_id=result.role,
                resolved_tasks=len(test_tasks),
                score=target_test.fused_rate,
            ),
        )
        response["ledger"] = str(ledger)
    typer.echo(json.dumps(response))


def _format_hillclimb_report(
    result: ClimbResult,
    diagnosis: ClimbDiagnosis,
    target_test: TargetCheck,
    n_test: int,
    budget_usd: float,
) -> str:
    # Use the full-bank diagnosis (not the train-subset one on result.diagnosis,
    # where decision tasks trivially give oracle 1.0) so the report is honest.
    diag = diagnosis
    val = result.target
    test = target_test
    lines = [
        "# Fusion Hill-Climb Report",
        "",
        f"- Role: {result.role}",
        f"- Advisory budget: ${budget_usd:.2f}",
        "",
        "## Diagnosis (frozen bank)",
        "",
        f"- Best single model: {diag.best_single_model or '-'} ({_fmt_num(diag.best_single_rate)})",
        f"- Oracle ceiling: {_fmt_num(diag.oracle_ceiling)}; headroom over best single: "
        f"{_fmt_num(diag.oracle_headroom)}",
        f"- Mean failure correlation (lower = more decorrelated): "
        f"{_fmt_num(diag.mean_failure_correlation)}",
        f"- Lopsided (low headroom): {'yes' if diag.lopsided else 'no'} -- {diag.note}",
        "",
        "## Result",
        "",
        f"- Val: fused {_fmt_num(val.fused_rate)} vs best single {_fmt_num(val.best_single_rate)} "
        f"(uplift {_fmt_num(val.uplift)}, beats={'yes' if val.beats_best_single else 'no'})",
        f"- LOCKED test ({n_test} tasks): fused {_fmt_num(test.fused_rate)} vs best single "
        f"{_fmt_num(test.best_single_rate)} (uplift {_fmt_num(test.uplift)})",
        f"- Test McNemar: wins={test.mcnemar.wins} losses={test.mcnemar.losses} "
        f"significant={'yes' if test.mcnemar.significant else 'no'}",
        f"- COMPOUND BEATS BEST SINGLE (locked test): "
        f"{'YES' if test.beats_best_single else 'no'}",
        "",
    ]
    return "\n".join(lines)


def _fmt_num(value: float | None) -> str:
    return "-" if value is None else f"{value:.4f}"


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


_COMMANDS = [
    ("eval", "eval", run_eval),
    ("pareto", "pareto", pareto),
    ("tiny", "tiny-bench", tiny_bench),
    ("fusion", "fusion-bench", fusion_bench),
    ("fusion-report", "fusion-bench-report", fusion_bench_report),
    ("public", "public-bench", public_bench),
    ("public-baselines", "public-bench-baselines", public_bench_baselines),
    ("tune-prompts", "tune-prompts", tune_prompts),
    ("hillclimb", "fusion-hillclimb", fusion_hillclimb),
    ("hillclimb-polyglot", "fusion-hillclimb-polyglot", fusion_hillclimb_polyglot),
]

for bench_name, _legacy_name, command in _COMMANDS:
    bench_app.command(bench_name)(command)


def register(app: typer.Typer) -> None:
    """Compatibility hook for non-shipping maintainer applications."""

    app.add_typer(bench_app, name="bench")
    for _bench_name, legacy_name, command in _COMMANDS:
        app.command(legacy_name, hidden=True)(command)

