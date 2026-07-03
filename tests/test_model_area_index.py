from __future__ import annotations

import json

import pytest
from model_area_index import (
    ModelAreaScore,
    TaskOutcome,
    build_model_area_matrix,
    build_task_outcome_panel_metrics,
    format_model_area_matrix_markdown,
    load_default_model_area_scores,
    recommend_panel,
)
from model_area_index.cli import main as model_area_index_main


def test_default_seed_snapshot_builds_model_area_matrix() -> None:
    scores = load_default_model_area_scores()
    matrix = build_model_area_matrix(scores)

    assert matrix.generated_from_records >= 10
    assert "coding_edit" in matrix.areas
    assert "gpt-5.5" in matrix.rows
    assert "deepseek-v3.2" in matrix.rows

    gpt = matrix.rows["gpt-5.5"].cells["coding_edit"]
    deepseek = matrix.rows["deepseek-v3.2"].cells["coding_edit"]
    assert gpt.normalized_score is not None
    assert deepseek.normalized_score is not None
    assert gpt.normalized_score > deepseek.normalized_score
    assert gpt.decorrelation_evidence_level == "aggregate_proxy"
    assert "aggregate proxy" in gpt.warnings[0]


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
    matrix = build_model_area_matrix(load_default_model_area_scores())
    recommendation = recommend_panel(matrix, target_profile="coding-agent", max_members=3)

    assert len(recommendation.members) == 3
    providers = {member.provider for member in recommendation.members}
    assert len(providers) == 3
    assert recommendation.objective_score > 0


def test_markdown_formatter_labels_aggregate_warning() -> None:
    matrix = build_model_area_matrix(load_default_model_area_scores(), areas=["coding_edit"])
    markdown = format_model_area_matrix_markdown(matrix)

    assert "Model Area Matrix" in markdown
    assert "routing priors" in markdown
    assert "gpt-5.5" in markdown


def test_model_area_matrix_cli_outputs_default_json(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = model_area_index_main(["--format", "json"])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["generated_from_records"] >= 10
    assert "coding_edit" in payload["areas"]
    assert "gpt-5.5" in payload["rows"]


def test_model_area_matrix_cli_outputs_recommendation(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = model_area_index_main(["--format", "json", "--target-profile", "coding-agent"])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["recommendation"]["target_profile"] == "coding-agent"
    assert len(payload["recommendation"]["members"]) == 3


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
