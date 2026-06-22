from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest
from fusionkit_cli.main import app
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import CostMetadata, FusionConfig, ModelEndpoint
from fusionkit_core.contracts import BenchmarkTaskRecordV1, FusionRunRequestV1, contract_metadata
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import FusionRunManager
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_evals.fusion_bench import (
    FUSION_BENCH_DISCLAIMER,
    CommandHandoffKitExecutor,
    FusionBenchAttemptRow,
    FusionBenchFailure,
    FusionBenchRunner,
    FusionBenchTask,
    build_fusion_bench_report,
    join_run_records,
    load_benchmark_tasks,
    load_fusion_bench_jsonl,
    score_fusion_bench_row,
    skip_row,
    write_fusion_bench_jsonl,
)
from fusionkit_evals.fusion_reports import (
    format_fusion_bench_html_report,
    format_fusion_bench_markdown_report,
    write_fusion_bench_html_report,
    write_fusion_bench_markdown_report,
    write_fusion_bench_report_jsonl,
)
from typer.testing import CliRunner

_HANDOFFKIT_NODE_SHIM = (
    "import os, subprocess, sys; "
    "raise SystemExit("
    "subprocess.call(['node', os.environ['HANDOFFKIT_CLI'], *sys.argv[1:]])"
    ")"
)


def test_fusion_bench_loads_tiny_manifests() -> None:
    tasks = load_benchmark_tasks()

    assert len(tasks) == 25
    assert all(isinstance(task.record, BenchmarkTaskRecordV1) for task in tasks)


def test_fusion_bench_loads_adversarial_native_fusion_ranker_fixtures() -> None:
    tasks = load_benchmark_tasks(
        "packages/fusionkit-evals/fixtures/adversarial-native-fusion"
    )

    assert len(tasks) == 2
    assert all(task.record.task_kind == "model_fusion" for task in tasks)
    assert all(task.record.source_repo == "fusionkit" for task in tasks)
    for task in tasks:
        params = task.record.scorer.params or {}
        assert params["public_claim_eligible"] is False
        assert "mvp_heuristic_ranker_limitation" in params


def test_adversarial_ranker_fixture_reports_regret_not_quality_claim() -> None:
    task = load_benchmark_tasks(
        "packages/fusionkit-evals/fixtures/adversarial-native-fusion"
    )[0]
    row = _report_row(
        task.record.task_id,
        output="Because there is evidence, therefore the answer is 5.",
        candidate_outputs={
            "keyword_bait": "Because there is evidence, therefore the answer is 5.",
            "terse_correct": "4",
        },
    ).model_copy(update={"task_record": task.record.model_dump(mode="json")})

    metrics = score_fusion_bench_row(row)

    assert metrics.synthesized_success == 0.0
    assert metrics.best_single_success == 1.0
    assert metrics.oracle_success == 1.0
    assert metrics.judge_synthesis_regret == 1.0


def test_fusion_bench_missing_manifest_fails_clearly(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        load_benchmark_tasks(tmp_path / "missing")


@pytest.mark.asyncio
async def test_fusion_bench_runs_native_task_and_joins_records(tmp_path) -> None:
    task = next(task for task in load_benchmark_tasks() if task.record.task_kind == "model_fusion")
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        model_versions={"fast": "fake-fast"},
    )

    rows = await runner.run_tasks([task])

    assert len(rows) == 1
    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.run_id
    assert row.trace_id
    assert row.fusion_record is not None
    assert row.model_call_records
    assert all(record.get("output_text") for record in row.model_call_records)
    assert score_fusion_bench_row(row).best_single_success is not None
    assert row.judge_synthesis_record is None
    assert row.artifact_records
    assert row.provider_metadata
    assert row.cost_estimate is not None
    assert row.schema_bundle_hash.startswith("sha256:")
    assert row.repo_sha
    assert row.model_versions == {"fast": "fake-fast"}
    assert row.manifest_hash.startswith("sha256:")
    assert all(
        "candidate with evidence" not in json.dumps(record)
        for record in row.artifact_records
    )
    assert "candidate with evidence" not in json.dumps(row.task_record)


@pytest.mark.asyncio
async def test_fusion_bench_emits_explicit_skip_for_harness_task(tmp_path) -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
    )

    rows = await runner.run_tasks([task])

    assert rows[0].failure.failure_kind == "unavailable_harness"
    assert rows[0].failure.owner == "handoffkit"
    assert rows[0].model_versions == {}
    assert rows[0].run_id is None


@pytest.mark.asyncio
async def test_fusion_bench_runs_harness_task_with_configured_executor(tmp_path) -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=_FakeHandoffExecutor(),
    )

    rows = await runner.run_tasks([task])

    assert len(rows) == 1
    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.status == "succeeded"
    assert row.run_id == f"harness_result_{task.record.task_id}"
    assert row.harness_run_result is not None
    assert row.harness_run_result["schema"] == "harness-run-result.v1"
    assert row.harness_candidate_records[0]["schema"] == "harness-candidate-record.v1"
    assert row.model_call_records[0]["schema"] == "model-call-record.v1"
    assert row.judge_synthesis_record is not None
    assert row.judge_synthesis_record["schema"] == "judge-synthesis-record.v1"
    assert row.tool_records[0]["schema"] == "tool-execution-record.v1"
    assert row.receipt_records[0]["schema"] == "ensemble-receipt.v1"
    assert row.artifact_records
    assert row.task_record["schema"] == "benchmark-task-record.v1"
    assert row.model_ids == ["fake-handoff"]

    metrics = score_fusion_bench_row(row)
    assert metrics.harness_verification_outcome == "succeeded"
    assert metrics.tool_success == 1.0
    assert metrics.judge_parse_failed is False


@pytest.mark.asyncio
async def test_fusion_bench_runs_harness_task_with_command_executor(tmp_path) -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    command_path = tmp_path / "fake_handoff_executor.py"
    command_path.write_text(_fake_handoff_command_script(), encoding="utf-8")
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=CommandHandoffKitExecutor([sys.executable, str(command_path)]),
    )

    rows = await runner.run_tasks([task])

    assert rows[0].failure.failure_kind == "none"
    assert rows[0].harness_run_result is not None
    assert rows[0].harness_run_result["result_id"] == f"harness_result_{task.record.task_id}"


@pytest.mark.asyncio
async def test_fusion_bench_invokes_real_handoffkit_handoff_command(tmp_path) -> None:
    handoffkit_cli = _handoffkit_cli_or_skip()
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    repo = _git_repo(tmp_path / "repo")
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=CommandHandoffKitExecutor(
            [
                sys.executable,
                "-c",
                _HANDOFFKIT_NODE_SHIM,
                "ensemble",
                "handoff",
                "--harness",
                "mock",
                "--repo",
                str(repo),
                "--out",
                str(tmp_path / "handoffkit-out"),
                "--id",
                "fusionkit_real_handoff",
            ],
            env={"HANDOFFKIT_CLI": str(handoffkit_cli)},
        ),
    )

    rows = await runner.run_tasks([task])

    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.status == "succeeded"
    assert row.harness_run_result is not None
    assert row.harness_run_result["schema"] == "harness-run-result.v1"
    assert row.harness_candidate_records
    assert row.judge_synthesis_record is not None
    assert row.model_ids


@pytest.mark.asyncio
async def test_fusion_bench_invokes_real_handoffkit_command_harness_patch_and_test(
    tmp_path,
) -> None:
    handoffkit_cli = _handoffkit_cli_or_skip()
    task = _coding_harness_task(tmp_path / "manifests" / "coding" / "calculator.json")
    repo = _coding_repo(tmp_path / "repo-command-patch")
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=CommandHandoffKitExecutor(
            [
                sys.executable,
                "-c",
                _HANDOFFKIT_NODE_SHIM,
                "ensemble",
                "handoff",
                "--harness",
                "command",
                "--command",
                "node fix-and-test.js",
                "--repo",
                str(repo),
                "--out",
                str(tmp_path / "handoffkit-out-command-patch"),
                "--id",
                "fusionkit_command_patch_handoff",
            ],
            env={"HANDOFFKIT_CLI": str(handoffkit_cli)},
        ),
    )

    rows = await runner.run_tasks([task])

    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.status == "succeeded"
    assert row.harness_run_result is not None
    assert row.harness_run_result["harness_kind"] == "generic"
    assert row.harness_candidate_records
    assert row.harness_candidate_records[0]["status"] == "succeeded"
    assert any(artifact.get("kind") == "patch" for artifact in row.artifact_records)
    transcript = next(
        artifact
        for artifact in row.artifact_records
        if artifact.get("kind") == "transcript" and isinstance(artifact.get("uri"), str)
    )
    assert "PATCH_TEST_OK" in _read_file_uri(transcript["uri"])
    assert score_fusion_bench_row(row).tool_success == 1.0


@pytest.mark.asyncio
async def test_fusion_bench_invokes_real_handoffkit_codex_harness_success_with_stub(
    tmp_path,
) -> None:
    handoffkit_cli = _handoffkit_cli_or_skip()
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    repo = _git_repo(tmp_path / "repo-codex-stub")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    codex = bin_dir / "codex"
    codex.write_text(
        "#!/bin/sh\n"
        "printf '{\"type\":\"session.started\",\"id\":\"stub\"}\\n'\n"
        "printf '{\"type\":\"turn.completed\",\"result\":\"stub codex completed\"}\\n'\n"
        "exit 0\n",
        encoding="utf-8",
    )
    codex.chmod(0o755)
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=CommandHandoffKitExecutor(
            [
                sys.executable,
                "-c",
                _HANDOFFKIT_NODE_SHIM,
                "ensemble",
                "handoff",
                "--harness",
                "codex",
                "--repo",
                str(repo),
                "--out",
                str(tmp_path / "handoffkit-out-codex-stub"),
                "--id",
                "fusionkit_codex_stub_handoff",
            ],
            env={
                "HANDOFFKIT_CLI": str(handoffkit_cli),
                "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                "CODEX_API_KEY": "test-codex-key",
                "OPENAI_API_KEY": None,
                "WARRANT_CODEX_RESPONSES_BASE_URL": None,
                "CODEX_RESPONSES_BASE_URL": None,
                "WARRANT_CODEX_OPENAI_BASE_URL": None,
                "OPENAI_BASE_URL": None,
            },
        ),
    )

    rows = await runner.run_tasks([task])

    row = rows[0]
    assert row.failure.failure_kind == "none"
    assert row.status == "succeeded"
    assert row.harness_run_result is not None
    assert row.harness_run_result["harness_kind"] == "codex"
    assert row.harness_run_result["status"] == "succeeded"
    assert row.harness_candidate_records
    assert {record["status"] for record in row.harness_candidate_records} == {"succeeded"}


@pytest.mark.asyncio
@pytest.mark.parametrize("harness_kind,expected_kind,expected_reason", [
    ("codex", "codex", "Codex credentials are absent"),
    ("claude-code", "claude_code", "Claude Code harness skipped"),
])
async def test_fusion_bench_invokes_real_handoffkit_coding_harness_skip_records(
    tmp_path,
    harness_kind: str,
    expected_kind: str,
    expected_reason: str,
) -> None:
    handoffkit_cli = _handoffkit_cli_or_skip()
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    repo = _git_repo(tmp_path / f"repo-{harness_kind}")
    empty_codex_home = tmp_path / "empty-codex-home"
    empty_codex_home.mkdir()
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=CommandHandoffKitExecutor(
            [
                sys.executable,
                "-c",
                _HANDOFFKIT_NODE_SHIM,
                "ensemble",
                "handoff",
                "--harness",
                harness_kind,
                "--repo",
                str(repo),
                "--out",
                str(tmp_path / f"handoffkit-out-{harness_kind}"),
                "--id",
                f"fusionkit_{harness_kind}_handoff",
            ],
            env={
                "HANDOFFKIT_CLI": str(handoffkit_cli),
                    "CODEX_HOME": str(empty_codex_home),
                "CODEX_API_KEY": None,
                "OPENAI_API_KEY": None,
                "WARRANT_CODEX_RESPONSES_BASE_URL": None,
                "CODEX_RESPONSES_BASE_URL": None,
                "WARRANT_CODEX_OPENAI_BASE_URL": None,
                "OPENAI_BASE_URL": None,
                "AI_GATEWAY_API_KEY": None,
                "AI_GATEWAY_BASE_URL": None,
                "ANTHROPIC_API_KEY": None,
                "ANTHROPIC_AUTH_TOKEN": None,
                "ANTHROPIC_BASE_URL": None,
                "VERCEL_TOKEN": None,
                "VERCEL_TEAM_ID": None,
                "VERCEL_PROJECT_ID": None,
            },
        ),
    )

    rows = await runner.run_tasks([task])

    row = rows[0]
    assert row.failure.failure_kind == "unavailable_harness"
    assert row.failure.owner == "handoffkit"
    assert row.status == "skipped"
    assert row.harness_run_result is not None
    assert row.harness_run_result["harness_kind"] == expected_kind
    assert expected_reason in (row.harness_run_result.get("output_summary") or "")


@pytest.mark.asyncio
async def test_fusion_bench_marks_invalid_handoff_records_as_validation_errors(tmp_path) -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
        handoff_executor=_InvalidHandoffExecutor(),
    )

    rows = await runner.run_tasks([task])

    assert rows[0].failure.failure_kind == "validation_error"
    assert rows[0].failure.error_code == "handoffkit_contract_validation_failed"
    assert rows[0].run_id is None


@pytest.mark.asyncio
async def test_fusion_bench_jsonl_round_trips_rows(tmp_path) -> None:
    tasks = load_benchmark_tasks()[:2]
    runner = FusionBenchRunner(
        _engine(),
        run_root=tmp_path / "runs",
        config_id="test",
        mode="single",
    )
    rows = await runner.run_tasks(tasks)
    output = tmp_path / "rows.jsonl"

    write_fusion_bench_jsonl(output, rows)
    loaded = load_fusion_bench_jsonl(output)

    assert loaded == rows


def test_join_run_records_does_not_require_raw_transcripts(tmp_path) -> None:
    task = next(task for task in load_benchmark_tasks() if task.record.task_kind == "model_fusion")
    store = FileSystemRunStore(tmp_path / "runs")
    manager = FusionRunManager(_engine(), store, LocalArtifactStore(tmp_path / "runs"))
    run_request = FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": "bench_join_test",
            "mode": "single",
            "messages": [{"role": "user", "content": task.record.prompt or ""}],
            "sampling": {},
        }
    )

    created = manager.create_run(run_request)
    assert created.run_id is not None

    inspection = asyncio.run(manager.execute_run(created.run_id))
    row = join_run_records(
        task,
        store.list_events(inspection.run_id),
        inspection,
        config_id="test",
        mode="single",
    )

    assert row.model_call_records
    assert row.fusion_record is not None


def test_fusion_bench_skip_row_can_use_custom_failure() -> None:
    task = next(
        task for task in load_benchmark_tasks() if task.record.task_kind == "harness_coding"
    )

    row = skip_row(
        task,
        config_id="test",
        mode="panel",
        failure=FusionBenchFailure(
            failure_kind="unavailable_provider",
            error_code="provider_missing",
            owner="fusionkit",
            terminal_reason="provider_not_configured",
        ),
    )

    assert row.failure.failure_kind == "unavailable_provider"
    assert row.failure.error_code == "provider_missing"


def test_fusion_bench_scores_hand_checked_task_metrics() -> None:
    row = _report_row(
        "task_a",
        output="good",
        candidate_outputs={"fast": "good", "slow": "bad"},
        tool_statuses=["succeeded", "failed"],
    )

    metrics = score_fusion_bench_row(row)

    assert metrics.synthesized_success == 1.0
    assert metrics.best_single_success == 1.0
    assert metrics.random_success == 0.5
    assert metrics.oracle_success == 1.0
    assert metrics.judge_synthesis_regret == 0.0
    assert metrics.tool_success == 0.5
    assert metrics.candidate_failure_rate == 0.5
    assert metrics.candidate_failures == {"fast": False, "slow": True}


def test_fusion_bench_skipped_rows_do_not_contribute_candidate_metrics() -> None:
    row = _report_row(
        "task_skipped_with_calls",
        output=None,
        candidate_outputs={"fast": "good"},
        failure=FusionBenchFailure(
            failure_kind="unavailable_harness",
            error_code="harness_unavailable",
            owner="handoffkit",
            terminal_reason="ensemble_adapter_not_configured",
        ),
        run_id=None,
    )

    metrics = score_fusion_bench_row(row)

    assert metrics.skipped is True
    assert metrics.best_single_success is None
    assert metrics.random_success is None
    assert metrics.oracle_success is None
    assert metrics.candidate_failures == {}


def test_fusion_bench_judge_parse_failures_are_explicit_and_unscored() -> None:
    row = _report_row(
        "task_invalid_judge_json",
        output="good",
        candidate_outputs={"fast": "good"},
    ).model_copy(
        update={
            "judge_synthesis_record": {
                "schema": "judge-synthesis-record.v1",
                "metrics": {"judge_structured_parse_status": "failed"},
                "judge_model_call_id": "judge_call_task_invalid_judge_json",
            }
        }
    )

    metrics = score_fusion_bench_row(row)
    report = build_fusion_bench_report([row])

    assert metrics.failed is True
    assert metrics.judge_parse_failed is True
    assert metrics.synthesized_success is None
    assert report.aggregate.failed_tasks == 1
    assert report.aggregate.judge_parse_failures == 1
    assert report.aggregate.synthesized_success is None


def test_fusion_bench_report_aggregates_metrics_and_outcomes() -> None:
    rows = _report_rows()

    report = build_fusion_bench_report(rows)

    assert report.aggregate.total_tasks == 4
    assert report.aggregate.succeeded_tasks == 2
    assert report.aggregate.skipped_tasks == 1
    assert report.aggregate.failed_tasks == 1
    assert report.aggregate.unscored_tasks == 2
    assert report.aggregate.synthesized_success == 0.5
    assert report.aggregate.best_single_success == 1.0
    assert report.aggregate.random_success == 0.5
    assert report.aggregate.oracle_success == 1.0
    assert report.aggregate.judge_synthesis_regret == 0.5
    assert report.aggregate.tool_success == 0.5
    assert report.aggregate.candidate_failure_rate == 0.5
    assert report.aggregate.failure_kinds["unavailable_harness"] == 1
    assert report.aggregate.harness_verification_outcomes == {
        "succeeded": 2,
        "skipped": 1,
        "failed": 1,
    }
    assert len(report.quality_cost_points) == 2
    assert len(report.quality_latency_points) == 2

    correlation = report.failure_correlations[0]
    assert correlation.left_model_id == "fast"
    assert correlation.right_model_id == "slow"
    assert correlation.n == 2
    assert correlation.correlation == pytest.approx(-1.0)


def test_fusion_bench_report_writers_do_not_include_raw_prompts(tmp_path) -> None:
    rows = _report_rows()
    report = build_fusion_bench_report(rows)
    jsonl_output = tmp_path / "report.jsonl"
    markdown_output = tmp_path / "report.md"
    html_output = tmp_path / "report.html"

    write_fusion_bench_report_jsonl(jsonl_output, report)
    write_fusion_bench_markdown_report(markdown_output, report)
    write_fusion_bench_html_report(html_output, report)

    jsonl_lines = [
        json.loads(line)
        for line in jsonl_output.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert jsonl_lines[0]["record_type"] == "metadata"
    assert jsonl_lines[1]["record_type"] == "aggregate"
    assert any(line["record_type"] == "task_metrics" for line in jsonl_lines)
    assert "SECRET_PROMPT" not in jsonl_output.read_text(encoding="utf-8")

    markdown = markdown_output.read_text(encoding="utf-8")
    html = html_output.read_text(encoding="utf-8")
    assert FUSION_BENCH_DISCLAIMER in markdown
    assert "- Skipped tasks: 1" in markdown
    assert "- Failed tasks: 1" in markdown
    assert "Quality vs Cost" in markdown
    assert "SECRET_PROMPT" not in markdown
    assert "SECRET_PROMPT" not in html


def test_fusion_bench_report_formatters_accept_rows() -> None:
    rows = _report_rows()

    markdown = format_fusion_bench_markdown_report(rows)
    html = format_fusion_bench_html_report(rows)

    assert "Fusion Bench Report" in markdown
    assert "Pairwise Failure Correlation" in markdown
    assert "<!doctype html>" in html


def test_fusion_bench_report_cli_writes_markdown_and_jsonl(tmp_path) -> None:
    input_path = tmp_path / "rows.jsonl"
    jsonl_output = tmp_path / "report.jsonl"
    markdown_output = tmp_path / "report.md"
    write_fusion_bench_jsonl(input_path, _report_rows())
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "fusion-bench-report",
            "--input",
            str(input_path),
            "--jsonl",
            str(jsonl_output),
            "--markdown",
            str(markdown_output),
        ],
    )

    assert result.exit_code == 0
    response = json.loads(result.stdout)
    assert response["rows"] == 4
    assert response["skipped"] == 1
    assert response["failed"] == 1
    assert jsonl_output.exists()
    assert markdown_output.exists()
    assert "Skipped tasks: 1" in markdown_output.read_text(encoding="utf-8")


def _handoffkit_cli_or_skip() -> Path:
    candidates = []
    if env_cli := os.environ.get("HANDOFFKIT_CLI"):
        candidates.append(Path(env_cli))
    candidates.extend(
        [
            Path(__file__).resolve().parents[2]
            / "handoffkit"
            / "packages"
            / "cli"
            / "dist"
            / "index.js",
            Path("/opt/velum/repos/handoffkit/packages/cli/dist/index.js"),
        ]
    )
    for cli in candidates:
        if cli.exists():
            return cli
    pytest.skip(
        "HandoffKit CLI build not found; run `pnpm build` in the sibling handoffkit repo"
    )


def _git_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "fusionkit@velum.local"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "fusionkit"], cwd=path, check=True)
    (path / "README.md").write_text("# fusionkit handoff e2e\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "init"], cwd=path, check=True)
    return path


def _coding_repo(path: Path) -> Path:
    repo = _git_repo(path)
    (repo / "calculator.js").write_text(
        "exports.add = (left, right) => left - right;\n",
        encoding="utf-8",
    )
    (repo / "calculator.test.js").write_text(
        "\n".join(
            [
                "const assert = require('node:assert/strict');",
                "const { add } = require('./calculator.js');",
                "assert.equal(add(2, 3), 5);",
                "console.log('TEST_OK');",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (repo / "fix-and-test.js").write_text(
        "\n".join(
            [
                "const fs = require('node:fs');",
                "fs.writeFileSync(",
                "  'calculator.js',",
                "  'exports.add = (left, right) => left + right;\\n'",
                ");",
                "require('./calculator.test.js');",
                "console.log('PATCH_TEST_OK');",
                "",
            ]
        ),
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(
        ["git", "commit", "--quiet", "-m", "add failing coding fixture"],
        cwd=repo,
        check=True,
    )
    return repo


def _coding_harness_task(path: Path) -> FusionBenchTask:
    path.parent.mkdir(parents=True)
    metadata = contract_metadata("benchmark-task-record.v1")
    record = BenchmarkTaskRecordV1.model_validate(
        {
            **metadata,
            "task_id": "fusionkit_command_patch_01",
            "task_kind": "harness_coding",
            "source_repo": "fusionkit",
            "source_sha": "c" * 40,
            "prompt": "Fix calculator.js so calculator.test.js passes, then run the test.",
            "prompt_hash": "sha256:" + "5" * 64,
            "setup_hash": "sha256:" + "6" * 64,
            "expected_evidence": [
                "Patch artifact changes calculator.js from subtraction to addition.",
                "Transcript contains PATCH_TEST_OK after running calculator.test.js.",
            ],
            "scorer": {"kind": "record_join", "params": {"smoke_only": True}},
            "holdout": False,
            "contamination_notes": "synthetic local coding e2e fixture",
            "allowed_tools": ["read_file", "write_file", "run_tests"],
        }
    )
    path.write_text(record.model_dump_json() + "\n", encoding="utf-8")
    return FusionBenchTask(category=path.parent.name, path=path, record=record)


def _read_file_uri(uri: str) -> str:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise AssertionError(f"Expected file URI, got {uri!r}")
    return Path(unquote(parsed.path)).read_text(encoding="utf-8")


class _FakeHandoffExecutor:
    async def run(self, task) -> list[dict[str, object]]:
        return _handoff_records(task)


class _InvalidHandoffExecutor:
    async def run(self, task) -> list[dict[str, object]]:
        metadata = contract_metadata("harness-run-result.v1")
        return [
            {
                **metadata,
                "request_id": f"harness_req_{task.record.task_id}",
                "harness_kind": "generic",
                "status": "succeeded",
                "candidate_ids": [],
                "capabilities": {"tool_call_loop": "supported"},
                "started_at": metadata["created_at"],
            }
        ]


def _handoff_records(task) -> list[dict[str, object]]:
    result_metadata = contract_metadata("harness-run-result.v1")
    candidate_metadata = contract_metadata("harness-candidate-record.v1")
    call_metadata = contract_metadata("model-call-record.v1")
    judge_metadata = contract_metadata("judge-synthesis-record.v1")
    tool_metadata = contract_metadata("tool-execution-record.v1")
    receipt_metadata = contract_metadata("ensemble-receipt.v1")
    artifact = {
        "artifact_id": f"artifact_{task.record.task_id}",
        "kind": "log",
        "hash": "sha256:" + "8" * 64,
        "uri": "memory://handoff/log",
        "redaction_status": "synthetic",
    }
    return [
        task.record.model_dump(mode="json"),
        {
            **result_metadata,
            "result_id": f"harness_result_{task.record.task_id}",
            "request_id": f"harness_req_{task.record.task_id}",
            "harness_kind": "generic",
            "status": "succeeded",
            "candidate_ids": [f"harness_candidate_{task.record.task_id}"],
            "output_summary": "harness final output",
            "artifacts": [artifact],
            "capabilities": {"tool_call_loop": "supported"},
            "started_at": result_metadata["created_at"],
            "finished_at": result_metadata["created_at"],
            "errors": [],
            "metadata": {"trace_id": f"trace_{task.record.task_id}"},
        },
        {
            **candidate_metadata,
            "candidate_id": f"harness_candidate_{task.record.task_id}",
            "request_id": f"harness_req_{task.record.task_id}",
            "harness_kind": "generic",
            "model_call_id": f"call_{task.record.task_id}",
            "status": "succeeded",
            "side_effects": "read_only",
            "artifacts": [artifact],
            "score": 1.0,
            "metadata": {"model_id": "fake-handoff"},
        },
        {
            **call_metadata,
            "call_id": f"call_{task.record.task_id}",
            "endpoint_id": "fake-handoff",
            "model": "fake-handoff-model",
            "request_hash": "sha256:" + "9" * 64,
            "status": "succeeded",
            "messages": [{"role": "user", "content": task.record.prompt or ""}],
            "side_effects": "read_only",
            "started_at": call_metadata["created_at"],
            "finished_at": call_metadata["created_at"],
            "latency_ms": 250.0,
            "output_text": "harness final output",
            "metadata": {"cost_estimate": 0.01},
        },
        {
            **judge_metadata,
            "synthesis_id": f"synthesis_{task.record.task_id}",
            "input_trajectory_ids": [f"harness_candidate_{task.record.task_id}"],
            "status": "succeeded",
            "decision": "select_trajectory",
            "final_output": "harness final output",
            "judge_model_call_id": f"call_{task.record.task_id}",
            "selected_trajectory_id": f"harness_candidate_{task.record.task_id}",
            "metrics": {"judge_structured_parse_status": "parsed"},
        },
        {
            **tool_metadata,
            "execution_id": f"tool_exec_{task.record.task_id}",
            "plan_id": f"tool_plan_{task.record.task_id}",
            "status": "succeeded",
            "output_hash": "sha256:" + "7" * 64,
        },
        {
            **receipt_metadata,
            "receipt_id": f"receipt_{task.record.task_id}",
            "run_id": f"harness_result_{task.record.task_id}",
            "status": "succeeded",
            "artifact_hashes": ["sha256:" + "8" * 64],
        },
    ]


def _fake_handoff_command_script() -> str:
    return """
import json
import sys

payload = json.load(sys.stdin)
task = payload["task"]
created_at = task["created_at"]
metadata = {
    "schema_version": "v1",
    "schema_bundle_hash": task["schema_bundle_hash"],
    "producer": "fake-handoff-command",
    "producer_version": "0.1.0",
    "producer_git_sha": "a" * 40,
    "created_at": created_at,
}
task_id = task["task_id"]
artifact = {
    "artifact_id": f"artifact_{task_id}",
    "kind": "log",
    "hash": "sha256:" + "8" * 64,
    "uri": "memory://handoff/log",
    "redaction_status": "synthetic",
}
records = [
    task,
    {
        **metadata,
        "schema": "harness-run-result.v1",
        "result_id": f"harness_result_{task_id}",
        "request_id": f"harness_req_{task_id}",
        "harness_kind": "generic",
        "status": "succeeded",
        "candidate_ids": [f"harness_candidate_{task_id}"],
        "output_summary": "harness command output",
        "artifacts": [artifact],
        "capabilities": {"tool_call_loop": "supported"},
        "started_at": created_at,
    },
    {
        **metadata,
        "schema": "harness-candidate-record.v1",
        "candidate_id": f"harness_candidate_{task_id}",
        "request_id": f"harness_req_{task_id}",
        "harness_kind": "generic",
        "status": "succeeded",
        "side_effects": "read_only",
        "artifacts": [artifact],
        "metadata": {"model_id": "fake-handoff"},
    },
]
json.dump({"records": records}, sys.stdout)
"""


def _engine() -> FusionEngine:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="fast",
                model="fake-fast",
                base_url="http://localhost:8101",
                pricing=CostMetadata(input_per_1m_tokens=1.0, output_per_1m_tokens=1.0),
            ),
        ],
        default_model="fast",
        default_mode="single",
    )
    return FusionEngine(
        config=config,
        clients={"fast": FakeModelClient("fast", ["candidate with evidence"])},
    )


def _report_rows() -> list[FusionBenchAttemptRow]:
    return [
        _report_row(
            "task_a",
            output="good",
            candidate_outputs={"fast": "good", "slow": "bad"},
            tool_statuses=["succeeded", "failed"],
        ),
        _report_row(
            "task_b",
            output="bad",
            candidate_outputs={"fast": "bad", "slow": "good"},
        ),
        _report_row(
            "task_skipped",
            output=None,
            candidate_outputs={},
            status=None,
            failure=FusionBenchFailure(
                failure_kind="unavailable_harness",
                error_code="harness_unavailable",
                owner="handoffkit",
                terminal_reason="ensemble_adapter_not_configured",
            ),
            run_id=None,
        ),
        _report_row(
            "task_failed",
            output=None,
            candidate_outputs={},
            status="failed",
            failure=FusionBenchFailure(
                failure_kind="run_failed",
                error_code="provider_error",
                owner="fusionkit",
                terminal_reason="provider_error",
            ),
        ),
    ]


def _report_row(
    task_id: str,
    *,
    output: str | None,
    candidate_outputs: dict[str, str],
    tool_statuses: list[str] | None = None,
    status: str | None = "succeeded",
    failure: FusionBenchFailure | None = None,
    run_id: str | None = "run_report",
) -> FusionBenchAttemptRow:
    return FusionBenchAttemptRow(
        task_id=task_id,
        category="synthetic",
        task_kind="model_fusion",
        manifest_path=f"/fixtures/{task_id}.json",
        manifest_hash="sha256:" + "1" * 64,
        schema_bundle_hash="sha256:" + "2" * 64,
        repo_sha="a" * 40,
        config_id="test",
        mode="panel",
        model_versions={"fast": "fake-fast", "slow": "fake-slow"},
        run_id=run_id,
        trace_id="trace_report" if run_id is not None else None,
        state="completed" if status == "succeeded" else None,
        status=status,
        output=output,
        failure=failure or FusionBenchFailure(),
        task_record=_task_record(task_id),
        model_call_records=[
            {
                "call_id": f"{model_id}_{task_id}",
                "endpoint_id": model_id,
                "model": f"fake-{model_id}",
                "output_text": candidate_output,
            }
            for model_id, candidate_output in candidate_outputs.items()
        ],
        tool_records=[
            {
                "schema": "tool-execution-record.v1",
                "execution_id": f"exec_{index}",
                "plan_id": f"plan_{index}",
                "status": tool_status,
            }
            for index, tool_status in enumerate(tool_statuses or [])
        ],
        provider_metadata=[{"cost_estimate": 0.2}],
        model_ids=list(candidate_outputs),
        cost_estimate=0.2 if output is not None else None,
        latency_s=1.0 if output is not None else None,
    )


def _task_record(task_id: str) -> dict[str, object]:
    return {
        "schema": "benchmark-task-record.v1",
        "schema_version": "v1",
        "task_id": task_id,
        "task_kind": "model_fusion",
        "source_repo": "fusionkit",
        "source_sha": "b" * 40,
        "prompt_hash": "sha256:" + "3" * 64,
        "setup_hash": "sha256:" + "4" * 64,
        "expected_evidence": ["synthetic"],
        "scorer": {"kind": "exact", "params": {"expected": "good"}},
        "holdout": False,
        "contamination_notes": "synthetic",
        "allowed_tools": [],
        "prompt": "SECRET_PROMPT should not appear in reports",
    }
