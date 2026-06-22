from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fusionkit_cli.main import app
from fusionkit_evals.benchmark_panel import (
    DECORRELATED_PEER_PANEL,
    LOPSIDED_DEFAULT_PANEL,
    estimate_panel_headroom,
    get_benchmark_panel,
)
from fusionkit_evals.gateway_target import GatewayTarget, default_dialect_for_runner
from fusionkit_evals.public_bench import (
    PUBLIC_BENCHMARK_SUITES,
    CommandExternalBenchmarkExecutor,
    ExternalBenchmarkError,
    ExternalBenchmarkRequest,
    ExternalBenchmarkRun,
    assert_public_benchmark_registry,
    baselines_for,
    best_baseline,
    panel_headroom_for_suite,
    panel_member_published_scores,
    parse_external_run,
    run_public_benchmark,
)
from fusionkit_evals.public_bench_report import (
    build_benchmark_comparison,
    format_benchmark_comparison_markdown,
)
from typer.testing import CliRunner

_SAMPLE_ENVELOPE = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "fusionkit-evals"
    / "fixtures"
    / "public-bench"
    / "aider-polyglot-subset.sample.json"
)


def _aider_request(panel_id: str = "decorrelated-peers") -> ExternalBenchmarkRequest:
    return ExternalBenchmarkRequest(
        suite="aider-polyglot",
        mount_mode="fusion_behind_agent",
        gateway_base_url="http://127.0.0.1:8080",
        gateway_model="fusionkit/panel",
        panel_id=panel_id,
        subset=3,
    )


def test_registry_has_info_and_baselines_for_every_suite() -> None:
    assert_public_benchmark_registry()
    for suite in PUBLIC_BENCHMARK_SUITES:
        assert baselines_for(suite)
        assert best_baseline(suite) is not None


def test_baselines_are_sorted_descending_by_score() -> None:
    scores = [baseline.score for baseline in baselines_for("swe-bench-pro")]
    assert scores == sorted(scores, reverse=True)
    top = best_baseline("swe-bench-pro")
    assert top is not None
    assert top.model == "claude-mythos"


def test_lopsided_default_panel_is_flagged_but_peer_panel_is_not() -> None:
    lopsided = panel_headroom_for_suite(LOPSIDED_DEFAULT_PANEL, "swe-bench-pro")
    peers = panel_headroom_for_suite(DECORRELATED_PEER_PANEL, "swe-bench-pro")

    assert lopsided.lopsided is True
    assert lopsided.best_single_score == pytest.approx(0.75)
    assert peers.lopsided is False
    assert peers.oracle_headroom is not None
    assert peers.oracle_headroom > 0


def test_panel_member_published_scores_matches_by_model_name() -> None:
    scores = panel_member_published_scores(LOPSIDED_DEFAULT_PANEL, "swe-bench-pro")

    assert scores == {"gpt": pytest.approx(0.75), "sonnet": pytest.approx(0.45)}


def test_estimate_panel_headroom_handles_unscored_panel() -> None:
    headroom = estimate_panel_headroom(DECORRELATED_PEER_PANEL, "swe-bench-pro", {})

    assert headroom.best_single_model is None
    assert headroom.oracle_ceiling is None
    assert "no published member scores" in headroom.note


def test_panel_to_fusion_config_uses_panel_members_and_judge() -> None:
    config = DECORRELATED_PEER_PANEL.to_fusion_config()

    assert [endpoint.id for endpoint in config.endpoints] == ["gpt", "opus", "gemini"]
    assert config.judge_model == "gpt"
    assert config.default_mode == "panel"
    assert config.panel_models == ["gpt", "opus", "gemini"]
    gpt = config.endpoint_for("gpt")
    assert gpt.base_url == "https://api.openai.com"
    assert gpt.api_key_env == "OPENAI_API_KEY"


def test_get_benchmark_panel_rejects_unknown_panel() -> None:
    with pytest.raises(KeyError, match="unknown benchmark panel"):
        get_benchmark_panel("does-not-exist")


def test_gateway_target_urls_and_env_by_dialect() -> None:
    chat = GatewayTarget(base_url="http://127.0.0.1:8080/")
    assert chat.endpoint_url == "http://127.0.0.1:8080/v1/chat/completions"
    assert chat.is_fusion_alias is True
    assert chat.runner_env()["OPENAI_BASE_URL"] == "http://127.0.0.1:8080"

    anthropic = GatewayTarget(dialect="anthropic-messages")
    assert anthropic.path == "/v1/messages"
    assert "ANTHROPIC_BASE_URL" in anthropic.runner_env()

    assert default_dialect_for_runner("claude-code") == "anthropic-messages"
    assert default_dialect_for_runner("codex") == "openai-responses"
    assert default_dialect_for_runner("aider") == "openai-chat"


def test_parse_external_run_derives_score_and_cost_from_sample() -> None:
    request = _aider_request()
    run = parse_external_run(_SAMPLE_ENVELOPE.read_text(encoding="utf-8"), request)

    assert run.availability == "ran"
    assert run.resolved_tasks == 3
    assert run.passed_tasks == 2
    assert run.score == pytest.approx(2 / 3)
    assert run.cost_total_usd == pytest.approx(4.5)
    assert run.cost_per_task_usd == pytest.approx(1.5)
    assert run.tasks[0].candidate_scores == {"gpt": 1.0, "opus": 0.0, "gemini": 1.0}


def test_parse_external_run_rejects_suite_mismatch() -> None:
    request = _aider_request()
    with pytest.raises(ExternalBenchmarkError, match="does not match request"):
        parse_external_run('{"suite": "swe-bench-pro"}', request)


def test_parse_external_run_rejects_empty_output() -> None:
    with pytest.raises(ExternalBenchmarkError, match="no output"):
        parse_external_run("   ", _aider_request())


async def test_run_public_benchmark_unavailable_without_executor() -> None:
    run = await run_public_benchmark(_aider_request(), None)

    assert run.availability == "unavailable"
    assert run.unavailable_reason


async def test_run_public_benchmark_with_fake_executor_returns_ran() -> None:
    class _FakeExecutor:
        async def run(self, request: ExternalBenchmarkRequest) -> ExternalBenchmarkRun:
            return parse_external_run(_SAMPLE_ENVELOPE.read_text(encoding="utf-8"), request)

    run = await run_public_benchmark(_aider_request(), _FakeExecutor())

    assert run.availability == "ran"
    assert run.score == pytest.approx(2 / 3)


async def test_command_executor_runs_adapter_script(tmp_path) -> None:
    script = tmp_path / "adapter.py"
    script.write_text(_fake_adapter_script(), encoding="utf-8")
    executor = CommandExternalBenchmarkExecutor([sys.executable, str(script)])

    run = await run_public_benchmark(_aider_request(), executor)

    assert run.availability == "ran"
    assert run.harness == "fake-aider"
    assert run.resolved_tasks == 2
    assert run.passed_tasks == 1
    assert run.score == pytest.approx(0.5)


async def test_command_executor_missing_binary_is_unavailable() -> None:
    executor = CommandExternalBenchmarkExecutor(["/nonexistent/fusionkit-adapter-xyz"])

    run = await run_public_benchmark(_aider_request(), executor)

    assert run.availability == "unavailable"


async def test_command_executor_nonzero_exit_is_failed(tmp_path) -> None:
    script = tmp_path / "boom.py"
    script.write_text("import sys; sys.stderr.write('boom'); sys.exit(3)\n", encoding="utf-8")
    executor = CommandExternalBenchmarkExecutor([sys.executable, str(script)])

    run = await run_public_benchmark(_aider_request(), executor)

    assert run.availability == "failed"
    assert run.unavailable_reason is not None
    assert "boom" in run.unavailable_reason


def test_build_comparison_reports_uplift_oracle_regret_and_correlation() -> None:
    request = _aider_request()
    run = parse_external_run(_SAMPLE_ENVELOPE.read_text(encoding="utf-8"), request)

    comparison = build_benchmark_comparison(run, DECORRELATED_PEER_PANEL)

    assert comparison.availability == "ran"
    assert comparison.fusion_score == pytest.approx(2 / 3)
    assert comparison.best_baseline_model == "gpt-5.5"
    assert comparison.uplift_vs_best_baseline == pytest.approx(2 / 3 - 0.88)
    assert comparison.measured_oracle == pytest.approx(1.0)
    assert comparison.measured_regret == pytest.approx(1.0 - 2 / 3)
    gpt_opus = next(
        row
        for row in comparison.failure_correlations
        if {row.left_model_id, row.right_model_id} == {"gpt", "opus"}
    )
    assert gpt_opus.correlation == pytest.approx(-0.5)

    markdown = format_benchmark_comparison_markdown(comparison)
    assert "Could fusion win at all?" in markdown
    assert "Published leaderboard (context only)" in markdown
    assert "gpt-5.5" in markdown


def test_build_comparison_for_unavailable_run_still_shows_headroom() -> None:
    run = ExternalBenchmarkRun(
        suite="swe-bench-pro",
        mount_mode="fusion_as_agent",
        availability="unavailable",
        panel_id="lopsided-default",
        gateway_model="fusionkit/panel",
        unavailable_reason="adapter not configured",
    )

    comparison = build_benchmark_comparison(run, LOPSIDED_DEFAULT_PANEL)
    markdown = format_benchmark_comparison_markdown(comparison)

    assert comparison.availability == "unavailable"
    assert comparison.fusion_score is None
    assert comparison.lopsided is True
    assert "Not run: adapter not configured" in markdown


def test_public_bench_cli_without_runner_writes_unavailable_report(tmp_path) -> None:
    output = tmp_path / "run.jsonl"
    report = tmp_path / "report.md"
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "public-bench",
            "--suite",
            "aider-polyglot",
            "--panel",
            "decorrelated-peers",
            "--subset",
            "5",
            "--output",
            str(output),
            "--report",
            str(report),
        ],
    )

    assert result.exit_code == 0
    response = json.loads(result.stdout)
    assert response["availability"] == "unavailable"
    assert response["suite"] == "aider-polyglot"
    assert output.exists()
    assert "Could fusion win at all?" in report.read_text(encoding="utf-8")


def test_public_bench_cli_with_adapter_reports_ran(tmp_path) -> None:
    script = tmp_path / "adapter.py"
    script.write_text(_fake_adapter_script(), encoding="utf-8")
    report = tmp_path / "report.md"
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "public-bench",
            "--suite",
            "aider-polyglot",
            "--runner-command",
            f"{sys.executable} {script}",
            "--report",
            str(report),
        ],
    )

    assert result.exit_code == 0
    response = json.loads(result.stdout)
    assert response["availability"] == "ran"
    assert response["fusion_score"] == pytest.approx(0.5)


def test_public_bench_cli_rejects_unknown_suite() -> None:
    runner = CliRunner()

    result = runner.invoke(app, ["public-bench", "--suite", "not-a-suite"])

    assert result.exit_code != 0


def test_public_bench_baselines_cli_outputs_suite_table() -> None:
    runner = CliRunner()

    result = runner.invoke(app, ["public-bench-baselines", "--suite", "aider-polyglot"])

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert "aider-polyglot" in payload
    assert any(entry["model"] == "gpt-5.5" for entry in payload["aider-polyglot"])


def test_public_bench_docs_document_strategy_and_boundaries() -> None:
    docs_path = (
        Path(__file__).resolve().parents[1] / "docs" / "public-benchmark-comparison.md"
    )
    docs = docs_path.read_text(encoding="utf-8")

    assert "Borrow the harness" in docs
    assert "decorrelated-peers" in docs
    assert "SWE-bench Verified" in docs
    assert "Subset first" in docs
    assert "unavailable" in docs


def _fake_adapter_script() -> str:
    return """
import json
import sys

request = json.load(sys.stdin)
envelope = {
    "suite": request["suite"],
    "harness": "fake-aider",
    "harness_version": "0.0.0",
    "model": request["gateway_model"],
    "resolved_tasks": 2,
    "total_tasks": 2,
    "passed_tasks": 1,
    "cost_total_usd": 3.0,
    "tasks": [
        {"task_id": "t1", "passed": True, "cost_usd": 1.5,
         "candidate_scores": {"gpt": 1.0, "opus": 0.0}},
        {"task_id": "t2", "passed": False, "cost_usd": 1.5,
         "candidate_scores": {"gpt": 0.0, "opus": 1.0}},
    ],
}
json.dump(envelope, sys.stdout)
"""
