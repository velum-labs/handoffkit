from __future__ import annotations

import json

import pytest
from model_area_index import (
    ModelAreaScore,
    TaskOutcome,
    build_model_area_matrix,
    build_task_outcome_panel_metrics,
    fetch_live_model_area_scores,
    format_model_area_matrix_markdown,
    recommend_panel,
    write_model_area_scores,
)
from model_area_index.cli import main as model_area_index_main


def test_fetch_live_model_area_scores_parses_representative_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payloads = {
        "aider.chat": _AIDER_HTML,
        "swe-bench": _SWE_JSON,
        "tbench.ai": _TERMINAL_HTML,
        "performances_generation": _LCB_GENERATION_JSON,
        "performances_execution": _LCB_EXECUTION_JSON,
        "performances_repair": _LCB_REPAIR_JSON,
        "performances_testgen": _LCB_TESTGEN_JSON,
    }

    def fake_fetch(url: str, *, timeout_s: float) -> bytes:
        del timeout_s
        for token, payload in payloads.items():
            if token in url:
                return payload.encode()
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr("model_area_index.core._fetch_url", fake_fetch)

    fetched = fetch_live_model_area_scores()
    matrix = build_model_area_matrix(fetched.scores)

    assert len(fetched.sources) == 7
    assert {source.record_count for source in fetched.sources}
    assert "coding_edit" in matrix.areas
    assert "swe_repair" in matrix.areas
    assert "terminal_agentic" in matrix.areas
    assert "competitive_programming" in matrix.areas
    assert "code_execution" in matrix.areas
    assert "code_repair" in matrix.areas
    assert "test_generation" in matrix.areas
    assert matrix.rows["gpt-5-high"].cells["coding_edit"].raw_score == pytest.approx(0.88)
    assert matrix.rows["claude-opus"].cells["swe_repair"].raw_score == pytest.approx(0.8)
    assert matrix.rows["gpt-5-5"].cells["terminal_agentic"].raw_score == pytest.approx(0.83)
    deepseek_cell = matrix.rows["deepseek-v3"].cells["competitive_programming"]
    gpt_cell = matrix.rows["gpt-5"].cells["competitive_programming"]
    assert deepseek_cell.decorrelation_evidence_level == "task_vector"
    assert deepseek_cell.raw_score is not None
    assert gpt_cell.raw_score is not None
    assert deepseek_cell.raw_score > gpt_cell.raw_score
    assert matrix.rows["claude-2"].cells["code_execution"].raw_score == pytest.approx(0.7)
    assert matrix.rows["qwen2-ins-72b"].cells["code_repair"].raw_score == pytest.approx(0.8)
    assert matrix.rows["dscoder-33b-ins"].cells["test_generation"].raw_score == pytest.approx(0.3)


def test_benchmark_local_normalization_does_not_mix_areas() -> None:
    scores = [
        _score("model-a", "openai", "bench", "reasoning", 80.0),
        _score("model-b", "anthropic", "bench", "reasoning", 70.0),
        _score("model-a", "openai", "bench", "math", 0.1),
        _score("model-b", "anthropic", "bench", "math", 0.9),
    ]

    matrix = build_model_area_matrix(scores)

    assert matrix.rows["model-a"].cells["reasoning"].normalized_score == pytest.approx(1.0)
    assert matrix.rows["model-a"].cells["math"].normalized_score == pytest.approx(0.0)
    assert matrix.rows["model-b"].cells["reasoning"].normalized_score == pytest.approx(0.0)
    assert matrix.rows["model-b"].cells["math"].normalized_score == pytest.approx(1.0)


def test_task_outcome_metrics_compute_oracle_and_failure_correlation() -> None:
    outcomes = [
        _outcome("t1", "gpt", 1.0),
        _outcome("t1", "opus", 0.0),
        _outcome("t1", "gemini", 1.0),
        _outcome("t2", "gpt", 0.0),
        _outcome("t2", "opus", 1.0),
        _outcome("t2", "gemini", 1.0),
        _outcome("t3", "gpt", 0.0),
        _outcome("t3", "opus", 0.0),
        _outcome("t3", "gemini", 1.0),
    ]

    metrics = build_task_outcome_panel_metrics(outcomes)

    assert metrics.decorrelation_evidence_level == "task_vector"
    assert metrics.common_task_count == 3
    assert metrics.best_single_model == "gemini"
    assert metrics.best_single_score == pytest.approx(1.0)
    assert metrics.oracle_score == pytest.approx(1.0)
    assert metrics.unique_win_rates["gemini"] == pytest.approx(1 / 3)
    gpt_opus = next(
        row
        for row in metrics.failure_correlations
        if {row.left_model_key, row.right_model_key} == {"gpt", "opus"}
    )
    assert gpt_opus.correlation == pytest.approx(-0.5)


def test_recommender_prefers_provider_diversity_for_coding_agent_profile() -> None:
    scores = [
        _score("gpt", "openai", "aider", "coding_edit", 0.9),
        _score("opus", "anthropic", "swe", "swe_repair", 0.8),
        _score("gemini", "google", "terminal", "terminal_agentic", 0.7),
        _score("deepseek", "deepseek", "lcb", "competitive_programming", 0.95),
    ]
    matrix = build_model_area_matrix(scores)

    recommendation = recommend_panel(matrix, target_profile="coding-agent", max_members=3)

    assert len(recommendation.members) == 3
    assert len({member.provider for member in recommendation.members}) == 3
    assert recommendation.objective_score > 0


def test_markdown_formatter_labels_aggregate_warning() -> None:
    matrix = build_model_area_matrix(
        [_score("gpt", "openai", "aider", "coding_edit", 0.88)],
        areas=["coding_edit"],
    )
    markdown = format_model_area_matrix_markdown(matrix)

    assert "Model Area Matrix" in markdown
    assert "routing priors" in markdown
    assert "gpt" in markdown


def test_cli_loads_snapshot_and_outputs_recommendation(
    tmp_path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    snapshot = tmp_path / "snapshot.jsonl"
    scores = [
        _score("gpt", "openai", "aider", "coding_edit", 0.9),
        _score("opus", "anthropic", "swe", "swe_repair", 0.8),
        _score("gemini", "google", "terminal", "terminal_agentic", 0.7),
    ]
    write_model_area_scores(snapshot, scores)

    exit_code = model_area_index_main(
        [
            "--snapshot",
            str(snapshot),
            "--format",
            "json",
            "--target-profile",
            "coding-agent",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["source_metadata"]["loaded_snapshot"] == str(snapshot)
    assert payload["recommendation"]["target_profile"] == "coding-agent"


def _score(
    model_key: str,
    provider: str,
    benchmark: str,
    area: str,
    raw: float,
) -> ModelAreaScore:
    return ModelAreaScore(
        model_key=model_key,
        provider=provider,
        model_family=model_key,
        model_version_or_alias=model_key,
        benchmark=benchmark,
        benchmark_version="v1",
        area=area,
        score_raw=raw,
        n_tasks=100,
        date_observed="2026-07-03",
        harness="official",
        source_url="https://example.com",
        source_snapshot_hash="test",
        data_level="aggregate",
        scoring="objective",
        same_harness_comparable=True,
    )


def _outcome(task_id: str, model_key: str, score: float) -> TaskOutcome:
    return TaskOutcome(
        benchmark="sample",
        benchmark_version="v1",
        task_id=task_id,
        task_area="coding_edit",
        model_key=model_key,
        passed_or_score=score,
        run_id_or_submission_id="public-artifact",
        harness="official",
        date_observed="2026-07-03",
    )


_AIDER_HTML = """
<tr class="details-row"><td><ul>
<li><strong>Test cases :</strong>225</li>
<li><strong>Model :</strong>gpt-5 (high)</li>
<li><strong>Pass rate 2 :</strong>88.0</li>
<li><strong>Total cost :</strong>29.08</li>
<li><strong>Command :</strong>aider --model openai/gpt-5</li>
<li><strong>Date :</strong>2026-07-03</li>
</ul></td></tr>
"""

_SWE_JSON = json.dumps(
    {
        "leaderboards": [
            {
                "name": "Verified",
                "results": [
                    {
                        "name": "Claude Opus",
                        "resolved": 80.0,
                        "date": "2026-07-03",
                        "cost": 12.0,
                        "os_system": True,
                    }
                ],
            }
        ]
    }
)

_TERMINAL_HTML = (
    r'\"rows\":[{\"agent\":\"Codex CLI\",\"model\":[\"GPT-5.5\"],'
    r'\"accuracy\":0.83,\"stderr\":0.01,\"date\":\"2026-07-03\",'
    r'\"modelNames\":[\"gpt-5.5\"],\"modelProviders\":[\"openai\"]}]'
)

_LCB_GENERATION_JSON = json.dumps(
    {
        "performances": [
            {"question_id": "a", "model": "DeepSeek-V3", "difficulty": "easy", "pass@1": 100},
            {"question_id": "b", "model": "DeepSeek-V3", "difficulty": "hard", "pass@1": 50},
            {"question_id": "a", "model": "GPT-5", "difficulty": "easy", "pass@1": 50},
            {"question_id": "b", "model": "GPT-5", "difficulty": "hard", "pass@1": 50},
        ]
    }
)

_LCB_EXECUTION_JSON = json.dumps(
    {
        "performances": [
            {
                "model": "Claude-2",
                "sample_id": "sample_0",
                "question_id": 2777,
                "Pass@1": 0.0,
                "Pass@1-COT": 70.0,
            }
        ]
    }
)

_LCB_REPAIR_JSON = json.dumps(
    {
        "performances": [
            {
                "question_id": "1873_A",
                "model": "Qwen2-Ins-72B",
                "difficulty": "easy",
                "pass@1": 80.0,
            }
        ]
    }
)

_LCB_TESTGEN_JSON = json.dumps(
    {
        "performances": [
            {
                "question_id": "2727",
                "model": "DSCoder-33b-Ins",
                "difficulty": "easy",
                "pass@1": 30.0,
            }
        ]
    }
)
