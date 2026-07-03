"""No-run public model capability index.

The index is not a benchmark runner. It ingests versioned public benchmark
snapshots, builds model-by-area score matrices, and only computes error
decorrelation from per-task outcomes on the same task ids.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

CapabilityDataLevel = Literal["aggregate", "subtask", "task_outcome", "model_answer"]
DecorrelationEvidenceLevel = Literal[
    "task_vector",
    "model_answer_replayable",
    "aggregate_proxy",
    "none",
]
ScoreDirection = Literal["higher_is_better", "lower_is_better"]
ScoringMode = Literal["deterministic_tests", "objective", "human_preference", "llm_judge"]
PanelProfile = Literal[
    "coding-agent",
    "general-reasoning",
    "low-cost-open-weight",
    "local-mlx",
    "mixed-frontier-open",
]

DATA_LEVEL_WEIGHTS: dict[CapabilityDataLevel, float] = {
    "task_outcome": 1.0,
    "model_answer": 0.9,
    "subtask": 0.65,
    "aggregate": 0.45,
}
SCORING_WEIGHTS: dict[ScoringMode, float] = {
    "deterministic_tests": 1.0,
    "objective": 0.9,
    "human_preference": 0.5,
    "llm_judge": 0.35,
}
PROFILE_AREA_WEIGHTS: dict[PanelProfile, dict[str, float]] = {
    "coding-agent": {
        "coding_edit": 0.3,
        "swe_repair": 0.25,
        "terminal_agentic": 0.2,
        "competitive_programming": 0.15,
        "reasoning": 0.1,
    },
    "general-reasoning": {
        "reasoning": 0.3,
        "math": 0.2,
        "instruction_following": 0.2,
        "data_analysis": 0.2,
        "long_context": 0.1,
    },
    "low-cost-open-weight": {
        "coding_edit": 0.25,
        "competitive_programming": 0.2,
        "reasoning": 0.2,
        "math": 0.15,
        "instruction_following": 0.1,
        "terminal_agentic": 0.1,
    },
    "local-mlx": {
        "coding_edit": 0.25,
        "reasoning": 0.25,
        "math": 0.2,
        "instruction_following": 0.2,
        "long_context": 0.1,
    },
    "mixed-frontier-open": {
        "coding_edit": 0.2,
        "swe_repair": 0.2,
        "terminal_agentic": 0.15,
        "competitive_programming": 0.15,
        "reasoning": 0.15,
        "math": 0.15,
    },
}

DEFAULT_MODEL_AREA_SNAPSHOT = (
    Path(__file__).resolve().parent / "data" / "public_model_area_scores.seed.jsonl"
)


class ModelAreaScore(BaseModel):
    """Aggregate or subtask public evidence for one model in one capability area."""

    model_key: str
    provider: str
    model_family: str
    model_version_or_alias: str
    benchmark: str
    benchmark_version: str
    area: str
    subarea: str | None = None
    score_raw: float
    score_normalized: float | None = Field(default=None, ge=0.0, le=1.0)
    score_direction: ScoreDirection = "higher_is_better"
    n_tasks: int | None = Field(default=None, ge=1)
    stderr_or_ci: str | float | None = None
    cost_usd: float | None = Field(default=None, ge=0.0)
    latency_s: float | None = Field(default=None, ge=0.0)
    date_observed: str
    harness: str | None = None
    prompting_mode: str | None = None
    source_url: str
    source_snapshot_hash: str
    data_level: CapabilityDataLevel = "aggregate"
    scoring: ScoringMode = "objective"
    contamination_weight: float = Field(default=1.0, ge=0.0, le=1.0)
    saturation_weight: float = Field(default=1.0, ge=0.0, le=1.0)
    freshness_weight: float = Field(default=1.0, ge=0.0, le=1.0)
    same_harness_comparable: bool = False

    @model_validator(mode="after")
    def _validate_score(self) -> ModelAreaScore:
        if not math.isfinite(self.score_raw):
            raise ValueError("score_raw must be finite")
        return self


class TaskOutcome(BaseModel):
    """Per-task outcome for true same-task decorrelation analysis."""

    benchmark: str
    benchmark_version: str
    task_id: str
    task_area: str
    task_subarea: str | None = None
    model_key: str
    passed_or_score: float = Field(ge=0.0, le=1.0)
    raw_output_ref: str | None = None
    run_id_or_submission_id: str
    harness: str
    date_observed: str


class AreaMatrixCell(BaseModel):
    area: str
    raw_score: float | None = None
    normalized_score: float | None = Field(default=None, ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    source_count: int = Field(ge=0)
    n_tasks: int | None = Field(default=None, ge=1)
    benchmarks: list[str] = Field(default_factory=list)
    data_levels: list[CapabilityDataLevel] = Field(default_factory=list)
    decorrelation_evidence_level: DecorrelationEvidenceLevel = "none"
    cost_usd: float | None = None
    latency_s: float | None = None
    warnings: list[str] = Field(default_factory=list)


class AreaMatrixRow(BaseModel):
    model_key: str
    provider: str
    model_family: str
    cells: dict[str, AreaMatrixCell] = Field(default_factory=dict)


class ModelAreaMatrix(BaseModel):
    """Rows are models; columns are capability areas."""

    generated_from_records: int
    models: list[str]
    areas: list[str]
    rows: dict[str, AreaMatrixRow]
    warning: str = (
        "Aggregate cells are routing priors only. Use TaskOutcome rows for true "
        "same-task error decorrelation."
    )


class FailureCorrelation(BaseModel):
    left_model_key: str
    right_model_key: str
    n: int
    correlation: float | None = None


class TaskOutcomePanelMetrics(BaseModel):
    benchmark: str
    benchmark_version: str
    model_keys: list[str]
    common_task_count: int
    best_single_model: str | None = None
    best_single_score: float | None = None
    oracle_score: float | None = None
    oracle_headroom: float | None = None
    failure_correlations: list[FailureCorrelation] = Field(default_factory=list)
    unique_win_rates: dict[str, float] = Field(default_factory=dict)
    decorrelation_evidence_level: DecorrelationEvidenceLevel = "none"


class PanelRecommendationMember(BaseModel):
    model_key: str
    provider: str
    score: float
    missing_areas: list[str] = Field(default_factory=list)


class PanelRecommendation(BaseModel):
    target_profile: PanelProfile
    members: list[PanelRecommendationMember]
    objective_score: float
    warnings: list[str] = Field(default_factory=list)


def default_model_area_snapshot_path() -> Path:
    return DEFAULT_MODEL_AREA_SNAPSHOT


def load_model_area_scores(path: str | Path) -> list[ModelAreaScore]:
    return [ModelAreaScore.model_validate(row) for row in _load_records(path)]


def load_task_outcomes(path: str | Path) -> list[TaskOutcome]:
    return [TaskOutcome.model_validate(row) for row in _load_records(path)]


def load_default_model_area_scores() -> list[ModelAreaScore]:
    return load_model_area_scores(DEFAULT_MODEL_AREA_SNAPSHOT)


def build_model_area_matrix(
    scores: Sequence[ModelAreaScore],
    *,
    areas: Sequence[str] | None = None,
) -> ModelAreaMatrix:
    target_areas = set(areas) if areas is not None else None
    records = [score for score in scores if target_areas is None or score.area in target_areas]
    normalized = _normalized_scores(records)
    by_model_area: dict[tuple[str, str], list[tuple[ModelAreaScore, float, float]]] = {}
    providers: dict[str, str] = {}
    families: dict[str, str] = {}
    for record, normalized_score in normalized:
        weight = _record_weight(record)
        by_model_area.setdefault((record.model_key, record.area), []).append(
            (record, normalized_score, weight)
        )
        providers.setdefault(record.model_key, record.provider)
        families.setdefault(record.model_key, record.model_family)

    rows: dict[str, AreaMatrixRow] = {}
    for (model_key, area), weighted_records in sorted(by_model_area.items()):
        row = rows.setdefault(
            model_key,
            AreaMatrixRow(
                model_key=model_key,
                provider=providers[model_key],
                model_family=families[model_key],
            ),
        )
        row.cells[area] = _build_cell(area, weighted_records)

    return ModelAreaMatrix(
        generated_from_records=len(records),
        models=sorted(rows),
        areas=sorted({area for _, area in by_model_area}),
        rows=rows,
    )


def build_task_outcome_panel_metrics(
    outcomes: Sequence[TaskOutcome],
    *,
    model_keys: Sequence[str] | None = None,
) -> TaskOutcomePanelMetrics:
    if not outcomes:
        return TaskOutcomePanelMetrics(
            benchmark="",
            benchmark_version="",
            model_keys=list(model_keys or []),
            common_task_count=0,
        )
    target_models = sorted(set(model_keys or [outcome.model_key for outcome in outcomes]))
    by_task: dict[str, dict[str, float]] = {}
    for outcome in outcomes:
        if outcome.model_key in target_models:
            by_task.setdefault(outcome.task_id, {})[outcome.model_key] = outcome.passed_or_score
    common_tasks = {
        task_id: scores
        for task_id, scores in by_task.items()
        if all(model_key in scores for model_key in target_models)
    }
    first = outcomes[0]
    if not common_tasks:
        return TaskOutcomePanelMetrics(
            benchmark=first.benchmark,
            benchmark_version=first.benchmark_version,
            model_keys=target_models,
            common_task_count=0,
        )

    model_means = {
        model_key: _average([scores[model_key] for scores in common_tasks.values()])
        for model_key in target_models
    }
    best_single_model = max(model_means, key=lambda key: model_means[key])
    best_single_score = model_means[best_single_model]
    oracle_score = _average([max(scores.values()) for scores in common_tasks.values()])
    unique_wins = {model_key: 0 for model_key in target_models}
    for scores in common_tasks.values():
        top = max(scores.values())
        winners = [model_key for model_key, score in scores.items() if score == top]
        if len(winners) == 1 and any(score < top for score in scores.values()):
            unique_wins[winners[0]] += 1
    denominator = len(common_tasks)
    return TaskOutcomePanelMetrics(
        benchmark=first.benchmark,
        benchmark_version=first.benchmark_version,
        model_keys=target_models,
        common_task_count=denominator,
        best_single_model=best_single_model,
        best_single_score=best_single_score,
        oracle_score=oracle_score,
        oracle_headroom=oracle_score - best_single_score,
        failure_correlations=_failure_correlations(common_tasks, target_models),
        unique_win_rates={
            model_key: wins / denominator for model_key, wins in unique_wins.items()
        },
        decorrelation_evidence_level="task_vector" if denominator >= 2 else "none",
    )


def recommend_panel(
    matrix: ModelAreaMatrix,
    *,
    target_profile: PanelProfile = "coding-agent",
    max_members: int = 3,
    max_cost_usd: float | None = None,
    require_provider_diversity: bool = True,
) -> PanelRecommendation:
    if max_members < 1:
        raise ValueError("max_members must be at least 1")
    area_weights = PROFILE_AREA_WEIGHTS[target_profile]
    candidates = [
        _score_recommendation_candidate(row, area_weights, max_cost_usd)
        for row in matrix.rows.values()
    ]
    eligible = [candidate for candidate in candidates if candidate is not None]
    eligible.sort(key=lambda candidate: candidate.score, reverse=True)
    selected: list[PanelRecommendationMember] = []
    seen_providers: set[str] = set()
    if require_provider_diversity:
        for candidate in eligible:
            if candidate.provider in seen_providers:
                continue
            selected.append(candidate)
            seen_providers.add(candidate.provider)
            if len(selected) == max_members:
                break
    for candidate in eligible:
        if len(selected) == max_members:
            break
        if candidate not in selected:
            selected.append(candidate)
    warnings = []
    if len(selected) < max_members:
        warnings.append("fewer eligible models than requested after constraints")
    if any(member.missing_areas for member in selected):
        warnings.append("one or more selected models lack evidence for profile areas")
    return PanelRecommendation(
        target_profile=target_profile,
        members=selected,
        objective_score=_average([member.score for member in selected]) if selected else 0.0,
        warnings=warnings,
    )


def format_model_area_matrix_markdown(matrix: ModelAreaMatrix) -> str:
    lines = [
        "# Model Area Matrix",
        "",
        f"Records: {matrix.generated_from_records}",
        "",
        f"Warning: {matrix.warning}",
        "",
    ]
    if not matrix.rows:
        return "\n".join([*lines, "_No model-area scores available._", ""])
    lines.extend(
        [
            "| Model | Provider | " + " | ".join(matrix.areas) + " |",
            "| --- | --- | " + " | ".join("---:" for _ in matrix.areas) + " |",
        ]
    )
    for model_key in matrix.models:
        row = matrix.rows[model_key]
        cells = [_format_cell(row.cells.get(area)) for area in matrix.areas]
        lines.append(f"| {model_key} | {row.provider} | " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


def _load_records(path: str | Path) -> list[Mapping[str, Any]]:
    input_path = Path(path)
    text = input_path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    if input_path.suffix == ".jsonl":
        records = [json.loads(line) for line in text.splitlines() if line.strip()]
    else:
        parsed = json.loads(text)
        records = parsed if isinstance(parsed, list) else parsed.get("records", [])
    if not isinstance(records, list):
        raise ValueError(f"{input_path} must contain a JSON array or JSONL records")
    return [record for record in records if isinstance(record, Mapping)]


def _normalized_scores(records: Sequence[ModelAreaScore]) -> list[tuple[ModelAreaScore, float]]:
    grouped: dict[tuple[str, str, str, str, str, str, str], list[ModelAreaScore]] = {}
    for record in records:
        key = (
            record.benchmark,
            record.benchmark_version,
            record.area,
            record.subarea or "",
            record.harness or "",
            record.prompting_mode or "",
            record.score_direction,
        )
        grouped.setdefault(key, []).append(record)

    normalized: list[tuple[ModelAreaScore, float]] = []
    for group in grouped.values():
        raw_values = [record.score_raw for record in group]
        low = min(raw_values)
        high = max(raw_values)
        for record in group:
            if record.score_normalized is not None:
                value = record.score_normalized
            elif high == low:
                value = 0.5
            else:
                value = (record.score_raw - low) / (high - low)
                if record.score_direction == "lower_is_better":
                    value = 1.0 - value
            normalized.append((record, value))
    return normalized


def _record_weight(record: ModelAreaScore) -> float:
    task_count_weight = (
        min(1.0, math.sqrt(record.n_tasks / 200.0))
        if record.n_tasks is not None
        else 0.5
    )
    same_harness_weight = 1.0 if record.same_harness_comparable else 0.65
    return (
        DATA_LEVEL_WEIGHTS[record.data_level]
        * SCORING_WEIGHTS[record.scoring]
        * record.contamination_weight
        * record.saturation_weight
        * record.freshness_weight
        * task_count_weight
        * same_harness_weight
    )


def _build_cell(
    area: str,
    weighted_records: Sequence[tuple[ModelAreaScore, float, float]],
) -> AreaMatrixCell:
    weights = [weight for _, _, weight in weighted_records]
    records = [record for record, _, _ in weighted_records]
    task_counts = [record.n_tasks for record in records if record.n_tasks is not None]
    warnings = []
    if all(record.data_level in ("aggregate", "subtask") for record in records):
        warnings.append("aggregate proxy; not same-task decorrelation evidence")
    return AreaMatrixCell(
        area=area,
        raw_score=_weighted_average([record.score_raw for record in records], weights),
        normalized_score=_weighted_average(
            [normalized for _, normalized, _ in weighted_records],
            weights,
        ),
        confidence=min(1.0, sum(weights) / len(weights)) if weights else 0.0,
        source_count=len(records),
        n_tasks=sum(task_counts) if task_counts else None,
        benchmarks=sorted({record.benchmark for record in records}),
        data_levels=sorted({record.data_level for record in records}),
        decorrelation_evidence_level=_decorrelation_evidence(records),
        cost_usd=_optional_weighted_average(
            [(record.cost_usd, weight) for record, _, weight in weighted_records]
        ),
        latency_s=_optional_weighted_average(
            [(record.latency_s, weight) for record, _, weight in weighted_records]
        ),
        warnings=warnings,
    )


def _decorrelation_evidence(records: Sequence[ModelAreaScore]) -> DecorrelationEvidenceLevel:
    levels = {record.data_level for record in records}
    if "task_outcome" in levels:
        return "task_vector"
    if "model_answer" in levels:
        return "model_answer_replayable"
    if levels & {"aggregate", "subtask"}:
        return "aggregate_proxy"
    return "none"


def _failure_correlations(
    common_tasks: Mapping[str, Mapping[str, float]],
    model_keys: Sequence[str],
) -> list[FailureCorrelation]:
    rows: list[FailureCorrelation] = []
    for left_index, left_model in enumerate(model_keys):
        for right_model in model_keys[left_index + 1 :]:
            left_failures = [
                1.0 if scores[left_model] < 1.0 else 0.0
                for scores in common_tasks.values()
            ]
            right_failures = [
                1.0 if scores[right_model] < 1.0 else 0.0
                for scores in common_tasks.values()
            ]
            rows.append(
                FailureCorrelation(
                    left_model_key=left_model,
                    right_model_key=right_model,
                    n=len(left_failures),
                    correlation=_pearson(left_failures, right_failures),
                )
            )
    return rows


def _pearson(left_values: Sequence[float], right_values: Sequence[float]) -> float | None:
    if len(left_values) < 2:
        return None
    left_mean = _average(left_values)
    right_mean = _average(right_values)
    numerator = sum(
        (left - left_mean) * (right - right_mean)
        for left, right in zip(left_values, right_values, strict=True)
    )
    left_denom = math.sqrt(sum((left - left_mean) ** 2 for left in left_values))
    right_denom = math.sqrt(sum((right - right_mean) ** 2 for right in right_values))
    if left_denom == 0 or right_denom == 0:
        return None
    return numerator / (left_denom * right_denom)


def _score_recommendation_candidate(
    row: AreaMatrixRow,
    area_weights: Mapping[str, float],
    max_cost_usd: float | None,
) -> PanelRecommendationMember | None:
    costs = [cell.cost_usd for cell in row.cells.values() if cell.cost_usd is not None]
    mean_cost = _average(costs) if costs else None
    if max_cost_usd is not None and mean_cost is not None and mean_cost > max_cost_usd:
        return None
    weighted_scores: list[float] = []
    weights: list[float] = []
    missing_areas: list[str] = []
    for area, weight in area_weights.items():
        cell = row.cells.get(area)
        if cell is None or cell.normalized_score is None:
            missing_areas.append(area)
            continue
        weighted_scores.append(cell.normalized_score)
        weights.append(weight * max(cell.confidence, 0.1))
    if not weighted_scores:
        return None
    score = _weighted_average(weighted_scores, weights)
    if mean_cost is not None:
        score -= min(0.2, math.log10(mean_cost + 1.0) * 0.03)
    return PanelRecommendationMember(
        model_key=row.model_key,
        provider=row.provider,
        score=max(0.0, score),
        missing_areas=missing_areas,
    )


def _weighted_average(values: Sequence[float], weights: Sequence[float]) -> float:
    denominator = sum(weights)
    if denominator <= 0:
        return _average(values)
    return sum(value * weight for value, weight in zip(values, weights, strict=True)) / denominator


def _optional_weighted_average(values: Iterable[tuple[float | None, float]]) -> float | None:
    filtered = [(value, weight) for value, weight in values if value is not None]
    if not filtered:
        return None
    return _weighted_average(
        [value for value, _ in filtered],
        [weight for _, weight in filtered],
    )


def _average(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _format_cell(cell: AreaMatrixCell | None) -> str:
    if cell is None or cell.normalized_score is None:
        return "-"
    return f"{cell.normalized_score:.3f} ({cell.confidence:.2f})"
