from __future__ import annotations

import json

import model_area_index.core as model_area_core
import pytest
from model_area_index import (
    ModelAreaScore,
    SourceSpec,
    TaskOutcome,
    build_data_quality_report,
    build_model_area_matrix,
    build_task_outcome_panel_metrics,
    fetch_live_model_area_scores,
    format_model_area_matrix_markdown,
    get_source_spec,
    get_source_specs,
    recommend_panel,
    register_source,
    write_model_area_scores,
    write_task_outcomes,
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
        "benchlm.ai": _BENCHLM_JSON,
        "open-llm-leaderboard": _OPEN_LLM_JSON,
        "comparison_dcgen": _UIBENCH_DCGEM_CSV,
        "comparison_design2code": _UIBENCH_DESIGN2CODE_CSV,
        "livebench": _LIVEBENCH_JSON,
        "artificialanalysis.ai": _ARTIFICIAL_ANALYSIS_JSON,
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

    assert len(fetched.sources) == 13
    assert {source.record_count for source in fetched.sources}
    assert "coding_edit" in matrix.areas
    assert "swe_repair" in matrix.areas
    assert "terminal_agentic" in matrix.areas
    assert "competitive_programming" in matrix.areas
    assert "code_execution" in matrix.areas
    assert "code_repair" in matrix.areas
    assert "test_generation" in matrix.areas
    assert "ui_to_code" in matrix.areas
    assert "ui_layout_structure" in matrix.areas
    assert "reasoning" in matrix.areas
    assert "math" in matrix.areas
    assert "instruction_following" in matrix.areas
    assert "hard_science_reasoning" in matrix.areas
    assert "agentic" in matrix.areas
    assert "data_analysis" in matrix.areas
    assert "intelligence" in matrix.areas
    assert "latency" in matrix.areas
    report = build_data_quality_report(fetched.scores)
    assert report.checked_rows == len(fetched.scores)
    assert report.error_count == 0
    assert "unknown_provider" in report.issue_counts
    assert matrix.rows["gpt-5-high"].cells["coding_edit"].raw_score == pytest.approx(0.88)
    assert matrix.rows["claude-opus"].cells["swe_repair"].raw_score == pytest.approx(0.8)
    assert matrix.rows["gpt-5-5"].cells["terminal_agentic"].raw_score == pytest.approx(0.83)
    deepseek_cell = matrix.rows["deepseek-v3"].cells["competitive_programming"]
    gpt_cell = matrix.rows["gpt-5"].cells["competitive_programming"]
    assert deepseek_cell.decorrelation_evidence_level == "aggregate_proxy"
    assert deepseek_cell.raw_score is not None
    assert gpt_cell.raw_score is not None
    assert deepseek_cell.raw_score > gpt_cell.raw_score
    assert matrix.rows["claude-2"].cells["code_execution"].raw_score == pytest.approx(0.7)
    assert matrix.rows["qwen2-ins-72b"].cells["code_repair"].raw_score == pytest.approx(0.8)
    assert matrix.rows["dscoder-33b-ins"].cells["test_generation"].raw_score == pytest.approx(0.3)
    assert matrix.rows["claude-mythos-5"].cells["agentic"].raw_score == pytest.approx(1.0)
    assert matrix.rows["qwen3-7-max"].cells["math"].raw_score == pytest.approx(0.902)
    assert matrix.rows["open-model"].cells[
        "hard_science_reasoning"
    ].raw_score == pytest.approx(0.25)
    assert matrix.rows["gemini-3-pro-preview"].cells["ui_to_code"].raw_score == pytest.approx(
        (0.86 + 0.80 + 0.92 + 0.84 + 0.81 + 0.91) / 6
    )
    gpt_high = next(score for score in fetched.scores if score.model_key == "gpt-5-high")
    assert gpt_high.base_model_key == "gpt-5"
    assert gpt_high.reasoning_effort == "high"
    swe_agent = next(score for score in fetched.scores if score.benchmark == "swe-bench")
    assert swe_agent.is_agent_system is True
    assert swe_agent.harness_or_agent == "swe-bench-agent"
    aa_score = next(score for score in fetched.scores if score.benchmark == "artificial-analysis")
    assert aa_score.provider_model_id == "aa-gpt"


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


def test_recommender_penalizes_capability_vector_similarity() -> None:
    scores = [
        _score("alpha", "openai", "bench", "coding_edit", 0.9),
        _score("alpha", "openai", "bench", "swe_repair", 0.9),
        _score("beta", "anthropic", "bench", "coding_edit", 0.85),
        _score("beta", "anthropic", "bench", "swe_repair", 0.85),
        _score("gamma", "google", "bench", "terminal_agentic", 0.7),
        _score("gamma", "google", "bench", "competitive_programming", 0.7),
    ]
    matrix = build_model_area_matrix(scores)

    recommendation = recommend_panel(
        matrix,
        target_profile="coding-agent",
        max_members=2,
        require_provider_diversity=False,
        similarity_penalty=0.4,
    )

    assert [member.model_key for member in recommendation.members] == ["alpha", "gamma"]
    assert recommendation.members[1].diversity_score > 0.9
    assert "aggregate proxy diversity" in recommendation.members[1].reason


def test_recommender_uses_task_outcome_metrics_when_available() -> None:
    scores = [
        _score("alpha", "openai", "bench", "coding_edit", 0.9),
        _score("alpha", "openai", "bench", "swe_repair", 0.9),
        _score("gamma", "google", "bench", "terminal_agentic", 0.65),
        _score("gamma", "google", "bench", "competitive_programming", 0.65),
    ]
    outcomes = [
        _outcome("t1", "alpha", 1.0),
        _outcome("t1", "gamma", 0.0),
        _outcome("t2", "alpha", 0.0),
        _outcome("t2", "gamma", 1.0),
        _outcome("t3", "alpha", 0.0),
        _outcome("t3", "gamma", 1.0),
    ]
    matrix = build_model_area_matrix(scores)
    task_metrics = [build_task_outcome_panel_metrics(outcomes)]

    recommendation = recommend_panel(
        matrix,
        target_profile="coding-agent",
        max_members=2,
        require_provider_diversity=False,
        task_outcome_metrics=task_metrics,
    )

    gamma = next(member for member in recommendation.members if member.model_key == "gamma")
    assert gamma.task_evidence_score > 0
    assert "task-outcome evidence" in gamma.reason


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


def test_cli_keeps_task_outcome_metrics_separate(
    tmp_path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    snapshot = tmp_path / "snapshot.jsonl"
    task_outcomes = tmp_path / "task-outcomes.jsonl"
    write_model_area_scores(snapshot, [_score("gpt", "openai", "aider", "coding_edit", 0.9)])
    write_task_outcomes(
        task_outcomes,
        [
            _outcome("t1", "gpt", 1.0),
            _outcome("t1", "opus", 0.0),
            _outcome("t2", "gpt", 0.0),
            _outcome("t2", "opus", 1.0),
        ],
    )

    exit_code = model_area_index_main(
        [
            "--snapshot",
            str(snapshot),
            "--task-outcome-snapshot",
            str(task_outcomes),
            "--format",
            "json",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert "task_outcome_metrics" in payload
    assert payload["task_outcome_metrics"][0]["decorrelation_evidence_level"] == "task_vector"
    assert payload["rows"]["gpt"]["cells"]["coding_edit"]["decorrelation_evidence_level"] == (
        "aggregate_proxy"
    )


def test_live_fetch_records_source_failure_without_strict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_fetch(url: str, *, timeout_s: float) -> bytes:
        del url, timeout_s
        raise model_area_core.FetchError("boom")

    monkeypatch.setattr("model_area_index.core._fetch_url", fail_fetch)

    fetched = fetch_live_model_area_scores(sources=("aider",))

    assert fetched.scores == []
    assert fetched.sources[0].availability == "failed"
    assert fetched.sources[0].error_reason == "boom"


def test_source_registry_is_discoverable_and_extensible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    specs = get_source_specs()
    assert len(specs) >= 13
    assert get_source_spec("benchlm").areas

    original_urls = dict(model_area_core.SOURCE_URLS)
    original_areas = dict(model_area_core.SOURCE_AREAS)
    original_descriptions = dict(model_area_core.SOURCE_DESCRIPTIONS)
    original_parsers = dict(model_area_core.SOURCE_PARSERS)
    original_live_sources = model_area_core.LIVE_SOURCES

    def parse_custom(
        text: str,
        source_url: str,
        snapshot_hash: str,
        retrieved_at: str,
        limit: int | None,
    ) -> list[ModelAreaScore]:
        del text, limit
        return [
            ModelAreaScore(
                model_key="custom-model",
                provider="custom-provider",
                model_family="custom",
                model_version_or_alias="custom-model",
                benchmark="custom-benchmark",
                benchmark_version="v1",
                area="custom_area",
                score_raw=0.75,
                score_normalized=0.75,
                date_observed=retrieved_at,
                source_url=source_url,
                source_snapshot_hash=snapshot_hash,
                data_level="aggregate",
                scoring="objective",
            )
        ]

    try:
        register_source(
            SourceSpec(
                source="custom_source",
                url="https://example.com/custom.json",
                parser=parse_custom,
                areas=("custom_area",),
                description="custom source for extension tests",
            )
        )
        monkeypatch.setattr("model_area_index.core._fetch_url", lambda *_args, **_kwargs: b"{}")

        fetched = fetch_live_model_area_scores(sources=("custom_source",))

        assert fetched.sources[0].source == "custom_source"
        assert fetched.scores[0].area == "custom_area"
        assert get_source_spec("custom_source").description == "custom source for extension tests"
    finally:
        model_area_core.SOURCE_URLS.clear()
        model_area_core.SOURCE_URLS.update(original_urls)
        model_area_core.SOURCE_AREAS.clear()
        model_area_core.SOURCE_AREAS.update(original_areas)
        model_area_core.SOURCE_DESCRIPTIONS.clear()
        model_area_core.SOURCE_DESCRIPTIONS.update(original_descriptions)
        model_area_core.SOURCE_PARSERS.clear()
        model_area_core.SOURCE_PARSERS.update(original_parsers)
        model_area_core.LIVE_SOURCES = original_live_sources


def test_data_quality_report_flags_concrete_row_problems() -> None:
    rows = [
        _score("model-a", "unknown", "bench", "unexpected_area", 0.5).model_copy(
            update={"source_url": "https://aider.chat/docs/leaderboards/"}
        ),
        _score("model-a", "unknown", "bench", "unexpected_area", 0.5).model_copy(
            update={"source_url": "https://aider.chat/docs/leaderboards/"}
        ),
        ModelAreaScore(
            model_key="task-model",
            provider="openai",
            model_family="task",
            model_version_or_alias="task-model",
            benchmark="task-bench",
            benchmark_version="v1",
            area="coding_edit",
            score_raw=0.5,
            date_observed="2026-07-03",
            source_url="https://aider.chat/docs/leaderboards/",
            source_snapshot_hash="task",
            data_level="task_outcome",
            scoring="objective",
            same_harness_comparable=False,
        ),
    ]

    report = build_data_quality_report(rows)

    assert report.error_count >= 2
    assert report.issue_counts["source_area_mismatch"] >= 1
    assert report.issue_counts["duplicate_row"] >= 1
    assert report.issue_counts["task_outcome_not_same_harness"] == 1
    assert report.issue_counts["unknown_provider"] >= 1


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

_BENCHLM_JSON = json.dumps(
    {
        "sourceLastUpdated": "July 2, 2026",
        "items": [
            {
                "model": "Claude Mythos 5",
                "creator": "Anthropic",
                "categoryScores": {
                    "agentic": 100,
                    "coding": 100,
                    "reasoning": 95,
                    "multimodalGrounded": 98.9,
                    "knowledge": 99.3,
                    "multilingual": 100,
                    "instructionFollowing": 91.4,
                    "math": 90,
                },
            },
            {
                "model": "Qwen3.7 Max",
                "creator": "Alibaba",
                "categoryScores": {
                    "agentic": 85,
                    "coding": 91.1,
                    "reasoning": 94.8,
                    "knowledge": 84.8,
                    "instructionFollowing": 88,
                    "math": 90.2,
                },
            },
        ],
    }
)

_OPEN_LLM_JSON = json.dumps(
    [
        {
            "model": {"name": "open/model"},
            "evaluations": {
                "ifeval": {"value": 0.7, "normalized_score": 70},
                "bbh": {"value": 0.6, "normalized_score": 60},
                "math": {"value": 0.2, "normalized_score": 20},
                "gpqa": {"value": 0.25, "normalized_score": 25},
                "musr": {"value": 0.4, "normalized_score": 40},
                "mmlu_pro": {"value": 0.5, "normalized_score": 50},
            },
        }
    ]
)

_UIBENCH_DCGEM_CSV = "\n".join(
    [
        "dataset,method,model,model_date,clip_avg,fg_block_match_avg,fg_text_avg,"
        "fg_position_avg,fg_color_avg,fg_clip_avg",
        "dcgen,direct,gemini-3-pro-preview,2026-01-10,0.86,0.80,0.92,0.84,0.81,0.91",
    ]
)

_UIBENCH_DESIGN2CODE_CSV = "\n".join(
    [
        "dataset,method,model,model_date,clip_avg,fg_block_match_avg,fg_text_avg,"
        "fg_position_avg,fg_color_avg,fg_clip_avg",
        "design2code,uicopilot,gpt-5,2026-03-08,0.85,0.70,0.75,0.69,0.67,0.86",
    ]
)

_LIVEBENCH_JSON = json.dumps(
    {
        "rows": [
            {
                "row": {
                    "question_id": "q1",
                    "task": "table_join",
                    "model": "open-model",
                    "score": 1.0,
                    "category": "data_analysis",
                }
            },
            {
                "row": {
                    "question_id": "q2",
                    "task": "table_join",
                    "model": "open-model",
                    "score": 0.0,
                    "category": "data_analysis",
                }
            },
            {
                "row": {
                    "question_id": "q3",
                    "task": "logic",
                    "model": "reasoner",
                    "score": 1.0,
                    "category": "reasoning",
                }
            },
        ]
    }
)

_ARTIFICIAL_ANALYSIS_JSON = json.dumps(
    {
        "data": [
            {
                "id": "aa-gpt",
                "slug": "gpt-5-high",
                "name": "GPT-5 (high)",
                "model_creator": {"name": "OpenAI"},
                "evaluations": {
                    "artificial_analysis_intelligence_index": 53.1,
                    "artificial_analysis_coding_index": 71.6,
                    "mmlu_pro": 0.82,
                    "gpqa": 0.7,
                    "livecodebench": 0.6,
                },
                "pricing": {
                    "price_1m_input_tokens": 5,
                    "price_1m_output_tokens": 30,
                },
                "performance": {
                    "median_output_tokens_per_second": 68.14,
                    "median_time_to_first_token_seconds": 10.03,
                },
            }
        ]
    }
)
