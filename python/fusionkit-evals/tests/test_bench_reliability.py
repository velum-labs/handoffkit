from __future__ import annotations

import json

import pytest
from fusionkit_evals.bench_history import BenchRunRecord, append_run, drift_vs_previous, load_runs
from fusionkit_evals.bench_runtime import classify_exception, is_transient, retry_async
from fusionkit_evals.bench_stats import (
    aggregate_seeds,
    bootstrap_ci,
    pass_at_k,
    wilson_interval,
)
from fusionkit_evals.benchmark_panel import DECORRELATED_PEER_PANEL
from fusionkit_evals.checkers import check_output
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.provenance import build_provenance, hash_text, package_versions
from fusionkit_evals.public_bench import (
    ExternalBenchmarkRequest,
    ExternalBenchmarkRun,
    ExternalBenchmarkTaskRow,
    parse_external_run,
)
from fusionkit_evals.public_bench_report import (
    LEADERBOARD_CONTEXT_NOTE,
    build_benchmark_comparison,
    format_benchmark_comparison_markdown,
)
from fusionkit_evals.sandbox import (
    DockerSandbox,
    LocalSandbox,
    SandboxConfig,
    SandboxUnavailable,
    build_sandbox,
)

# --- sandbox -----------------------------------------------------------------


def test_local_sandbox_runs_and_captures_output() -> None:
    result = LocalSandbox().run("print(6 * 7)", "", timeout_s=10)

    assert result.ok
    assert result.stdout.strip() == "42"


def test_local_sandbox_passes_stdin() -> None:
    code = "import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))"
    result = LocalSandbox().run(code, "1 2 3 4", timeout_s=10)

    assert result.stdout.strip() == "10"


def test_local_sandbox_scrubs_secrets(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-super-secret-value")
    monkeypatch.setenv("FK_FAKE_SECRET", "leak-me")

    result = LocalSandbox().run(
        "import os\nprint(os.environ.get('OPENAI_API_KEY'))\n"
        "print(os.environ.get('FK_FAKE_SECRET'))",
        "",
        timeout_s=10,
    )

    assert "sk-super-secret-value" not in result.stdout
    assert "leak-me" not in result.stdout
    assert result.stdout.strip().splitlines() == ["None", "None"]


def test_local_sandbox_times_out() -> None:
    result = LocalSandbox(cpu_seconds=2).run("while True:\n    pass", "", timeout_s=1)

    assert not result.ok


def test_local_sandbox_caps_output() -> None:
    result = LocalSandbox(output_limit_bytes=2048).run(
        "print('A' * 5_000_000)", "", timeout_s=10
    )

    # Either the OS killed the writer (RLIMIT_FSIZE) or the read was truncated.
    assert result.output_truncated or not result.ok


def test_local_sandbox_nonzero_exit() -> None:
    result = LocalSandbox().run("raise SystemExit(3)", "", timeout_s=10)

    assert result.returncode == 3
    assert not result.ok


def test_build_sandbox_local_default() -> None:
    sandbox = build_sandbox(SandboxConfig(backend="local"))
    assert sandbox.backend == "local"


def test_build_sandbox_rejects_unknown_backend() -> None:
    with pytest.raises(SandboxUnavailable):
        build_sandbox(SandboxConfig(backend="nope"))


def test_docker_sandbox_command_has_isolation_flags() -> None:
    command = DockerSandbox().docker_command("/tmp/work")
    assert "--network" in command and "none" in command
    assert "--read-only" in command
    assert "--pids-limit" in command


def test_docker_sandbox_unavailable_without_binary() -> None:
    sandbox = DockerSandbox(docker_bin="definitely-not-docker-xyz")
    with pytest.raises(SandboxUnavailable):
        sandbox.run("print(1)", "", timeout_s=5)


# --- code extraction ---------------------------------------------------------


def test_extract_fenced_python_prefers_largest_block() -> None:
    text = "prose\n```python\nprint(1)\n```\nmore\n```python\nprint('hello world')\n```"
    extracted = extract_code(text)
    assert extracted.method == "fenced_python"
    assert "hello world" in extracted.code


def test_extract_fenced_any() -> None:
    extracted = extract_code("```\nprint(1)\n```")
    assert extracted.method == "fenced_any"
    assert extracted.code == "print(1)"


def test_extract_heuristic_prose_strip() -> None:
    extracted = extract_code("Here is the answer:\nimport sys\nprint(42)")
    assert extracted.method == "heuristic_prose_strip"
    assert extracted.code.startswith("import sys")


def test_extract_empty_and_raw() -> None:
    assert extract_code("   ").method == "empty"
    assert extract_code("just words").method == "raw"


# --- checkers ----------------------------------------------------------------


def test_exact_and_token_checkers() -> None:
    assert check_output("YES\n", "YES", mode="exact")
    assert not check_output("YES", "yes", mode="exact")
    assert check_output("1 2 3", "1\n2\n3", mode="token")


def test_case_insensitive_checker() -> None:
    assert check_output("Yes", "YES", mode="case_insensitive")


def test_float_checker_tolerance() -> None:
    assert check_output("1.0 2.0", "1.0000001 2.0", mode="float")
    assert not check_output("1.0", "1.1", mode="float")
    assert not check_output("1.0 2.0", "1.0", mode="float")


# --- stats -------------------------------------------------------------------


def test_wilson_interval_brackets_estimate() -> None:
    ci = wilson_interval(5, 10)
    assert ci.estimate == 0.5
    assert 0.0 < ci.low < 0.5 < ci.high < 1.0


def test_wilson_interval_handles_zero_n() -> None:
    ci = wilson_interval(0, 0)
    assert ci.low == 0.0 and ci.high == 0.0


def test_pass_at_k() -> None:
    assert pass_at_k(5, 0, 1) == 0.0
    assert pass_at_k(5, 5, 1) == 1.0
    assert pass_at_k(5, 1, 1) == pytest.approx(0.2)


def test_aggregate_seeds_and_bootstrap() -> None:
    agg = aggregate_seeds([0.4, 0.5, 0.6])
    assert agg.runs == 3
    assert agg.mean == pytest.approx(0.5)
    assert agg.low < agg.mean < agg.high
    low, high = bootstrap_ci([0.0, 1.0, 1.0, 0.0, 1.0], iterations=200, seed=1)
    assert 0.0 <= low <= high <= 1.0


# --- runtime: taxonomy + retries --------------------------------------------


def test_is_transient_and_classification() -> None:
    assert is_transient(TimeoutError("timed out"))
    assert classify_exception(TimeoutError()) == "infra_error"
    assert not is_transient(ValueError("bad input"))
    assert classify_exception(ValueError("bad")) == "model_failed"


def test_is_transient_uses_status_code() -> None:
    class Boom(Exception):
        status_code = 429

    assert is_transient(Boom())


async def test_retry_async_succeeds_after_transient_failures() -> None:
    calls = {"n": 0}

    async def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise TimeoutError("transient")
        return "ok"

    async def _no_sleep(_: float) -> None:
        return None

    result = await retry_async(flaky, attempts=3, sleep=_no_sleep)
    assert result == "ok"
    assert calls["n"] == 3


async def test_retry_async_reraises_non_transient_immediately() -> None:
    calls = {"n": 0}

    async def hard() -> str:
        calls["n"] += 1
        raise ValueError("not retryable")

    with pytest.raises(ValueError, match="not retryable"):
        await retry_async(hard, attempts=5)
    assert calls["n"] == 1


# --- history -----------------------------------------------------------------


def test_history_append_load_and_drift(tmp_path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    append_run(ledger, BenchRunRecord(suite="livecodebench", panel_id="p", score=0.60))

    assert len(load_runs(ledger)) == 1

    regression = drift_vs_previous(
        ledger, BenchRunRecord(suite="livecodebench", panel_id="p", score=0.50)
    )
    assert regression is not None
    assert regression.delta == pytest.approx(-0.10)
    assert regression.regressed is True

    improvement = drift_vs_previous(
        ledger, BenchRunRecord(suite="livecodebench", panel_id="p", score=0.62)
    )
    assert improvement is not None
    assert improvement.regressed is False


def test_history_drift_none_without_prior(tmp_path) -> None:
    ledger = tmp_path / "ledger.jsonl"
    assert drift_vs_previous(ledger, BenchRunRecord(suite="s", panel_id="p", score=0.5)) is None


# --- provenance --------------------------------------------------------------


def test_build_provenance_captures_environment() -> None:
    prov = build_provenance(prompt_template="solve it", model_versions={"gpt": "gpt-5.5"})
    assert prov["repo_sha"]
    assert prov["python_version"]
    assert prov["model_versions"] == {"gpt": "gpt-5.5"}
    assert prov["prompt_template_hash"].startswith("sha256:")
    assert isinstance(package_versions(), dict)


def test_hash_text_is_stable() -> None:
    assert hash_text("abc") == hash_text("abc")
    assert hash_text("abc") != hash_text("abd")


# --- taxonomy parsing + report guardrails ------------------------------------


def _request() -> ExternalBenchmarkRequest:
    return ExternalBenchmarkRequest(
        suite="livecodebench",
        mount_mode="fusion_behind_agent",
        gateway_base_url="http://127.0.0.1:8080",
        gateway_model="fusionkit/panel",
        panel_id="decorrelated-peers",
    )


def test_parse_external_run_keeps_taxonomy_out_of_the_denominator() -> None:
    envelope = {
        "suite": "livecodebench",
        "tasks": [
            {"task_id": "a", "outcome": "scored", "passed": True,
             "candidate_scores": {"gpt": 1.0, "opus": 0.0}},
            {"task_id": "b", "outcome": "scored", "passed": False,
             "candidate_scores": {"gpt": 0.0, "opus": 0.0}},
            {"task_id": "c", "outcome": "infra_error", "error_reason": "timeout"},
            {"task_id": "d", "outcome": "excluded", "error_reason": "no_tests"},
        ],
    }
    run = parse_external_run(json.dumps(envelope), _request())

    assert run.resolved_tasks == 2  # only scored tasks count toward the denominator
    assert run.passed_tasks == 1
    assert run.score == pytest.approx(0.5)
    assert run.total_tasks == 4
    assert run.infra_error_tasks == 1
    assert run.excluded_tasks == 1
    assert run.model_failed_tasks == 0


def test_report_leads_within_run_and_labels_leaderboard_context() -> None:
    run = ExternalBenchmarkRun(
        suite="livecodebench",
        mount_mode="fusion_behind_agent",
        availability="ran",
        panel_id="decorrelated-peers",
        gateway_model="fusionkit/panel",
        resolved_tasks=10,
        total_tasks=12,
        passed_tasks=6,
        infra_error_tasks=1,
        excluded_tasks=1,
        score=0.6,
        tasks=[
            ExternalBenchmarkTaskRow(
                task_id=f"t{i}",
                outcome="scored",
                passed=i < 6,
                score=1.0 if i < 6 else 0.0,
                candidate_scores={"gpt": float(i % 2), "opus": float((i + 1) % 2)},
            )
            for i in range(10)
        ],
    )

    comparison = build_benchmark_comparison(run, DECORRELATED_PEER_PANEL)
    markdown = format_benchmark_comparison_markdown(comparison)

    assert comparison.fusion_ci_low is not None and comparison.fusion_ci_high is not None
    assert comparison.infra_error_tasks == 1
    assert comparison.excluded_tasks == 1
    assert "95% CI (Wilson)" in markdown
    assert "Published leaderboard (context only)" in markdown
    assert LEADERBOARD_CONTEXT_NOTE in markdown
