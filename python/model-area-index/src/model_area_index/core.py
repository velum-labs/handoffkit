"""No-run public model capability index built from live benchmark data."""

from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field, model_validator

CapabilityDataLevel = Literal["aggregate", "subtask", "task_outcome", "model_answer"]
DecorrelationEvidenceLevel = Literal[
    "task_vector",
    "model_answer_replayable",
    "aggregate_proxy",
    "none",
]
ValidationSeverity = Literal["error", "warning"]
SourceAvailability = Literal["ran", "unavailable", "failed"]
ScoreDirection = Literal["higher_is_better", "lower_is_better"]
ScoringMode = Literal["deterministic_tests", "objective", "human_preference", "llm_judge"]
PanelProfile = Literal[
    "coding-agent",
    "general-reasoning",
    "low-cost-open-weight",
    "local-mlx",
    "mixed-frontier-open",
]
LiveSource = str

LIVE_SOURCES: tuple[LiveSource, ...] = (
    "aider",
    "swe_bench",
    "terminal_bench",
    "livecodebench_generation",
    "livecodebench_execution",
    "livecodebench_repair",
    "livecodebench_testgen",
    "benchlm",
    "open_llm_leaderboard",
    "uibenchkit_dcgen",
    "uibenchkit_design2code",
)
SOURCE_URLS: dict[LiveSource, str] = {
    "aider": "https://aider.chat/docs/leaderboards/",
    "swe_bench": (
        "https://raw.githubusercontent.com/swe-bench/swe-bench.github.io/"
        "master/data/leaderboards.json"
    ),
    "terminal_bench": "https://www.tbench.ai/leaderboard/terminal-bench/2.1",
    "livecodebench_generation": (
        "https://raw.githubusercontent.com/LiveCodeBench/livecodebench.github.io/"
        "main/src/mocks/performances_generation.json"
    ),
    "livecodebench_execution": (
        "https://raw.githubusercontent.com/LiveCodeBench/livecodebench.github.io/"
        "main/src/mocks/performances_execution.json"
    ),
    "livecodebench_repair": (
        "https://raw.githubusercontent.com/LiveCodeBench/livecodebench.github.io/"
        "main/src/mocks/performances_repair.json"
    ),
    "livecodebench_testgen": (
        "https://raw.githubusercontent.com/LiveCodeBench/livecodebench.github.io/"
        "main/src/mocks/performances_testgen.json"
    ),
    "benchlm": "https://benchlm.ai/data/leaderboard.json",
    "open_llm_leaderboard": (
        "https://open-llm-leaderboard-open-llm-leaderboard.hf.space/api/"
        "leaderboard/formatted"
    ),
    "uibenchkit_dcgen": (
        "https://raw.githubusercontent.com/chinh02/uibenchkit-experiments/main/"
        "leaderboard/comparison_dcgen.csv"
    ),
    "uibenchkit_design2code": (
        "https://raw.githubusercontent.com/chinh02/uibenchkit-experiments/main/"
        "leaderboard/comparison_design2code.csv"
    ),
}
SOURCE_AREAS: dict[LiveSource, tuple[str, ...]] = {
    "aider": ("coding_edit",),
    "swe_bench": ("swe_repair",),
    "terminal_bench": ("terminal_agentic",),
    "livecodebench_generation": ("competitive_programming",),
    "livecodebench_execution": ("code_execution",),
    "livecodebench_repair": ("code_repair",),
    "livecodebench_testgen": ("test_generation",),
    "benchlm": (
        "agentic",
        "coding_general",
        "reasoning",
        "multimodal_grounded",
        "knowledge",
        "multilingual",
        "instruction_following",
        "math",
    ),
    "open_llm_leaderboard": (
        "instruction_following",
        "reasoning",
        "math",
        "hard_science_reasoning",
        "multi_step_reasoning",
        "knowledge",
    ),
    "uibenchkit_dcgen": (
        "ui_to_code",
        "ui_visual_fidelity",
        "ui_layout_structure",
        "ui_text_fidelity",
        "ui_color_fidelity",
    ),
    "uibenchkit_design2code": (
        "ui_to_code",
        "ui_visual_fidelity",
        "ui_layout_structure",
        "ui_text_fidelity",
        "ui_color_fidelity",
    ),
}
USER_AGENT = "model-area-index/0.1 (+https://github.com/velum-labs/handoffkit)"

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
        "knowledge": 0.15,
        "hard_science_reasoning": 0.1,
        "multi_step_reasoning": 0.05,
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
        "coding_general": 0.25,
        "reasoning": 0.25,
        "math": 0.2,
        "instruction_following": 0.2,
        "knowledge": 0.1,
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
SWE_TASK_COUNTS: dict[str, int] = {
    "bash-only": 500,
    "Multilingual": 300,
    "Test": 2294,
    "Verified": 500,
    "Lite": 300,
    "Multimodal": 517,
}
BENCHLM_CATEGORY_AREAS: dict[str, str] = {
    "agentic": "agentic",
    "coding": "coding_general",
    "reasoning": "reasoning",
    "multimodalGrounded": "multimodal_grounded",
    "knowledge": "knowledge",
    "multilingual": "multilingual",
    "instructionFollowing": "instruction_following",
    "math": "math",
}
OPEN_LLM_EVAL_AREAS: dict[str, str] = {
    "ifeval": "instruction_following",
    "bbh": "reasoning",
    "math": "math",
    "gpqa": "hard_science_reasoning",
    "musr": "multi_step_reasoning",
    "mmlu_pro": "knowledge",
}
UIBENCHKIT_TASK_COUNTS: dict[str, int] = {
    "dcgen": 348,
    "design2code": 484,
}


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
    capability_score: float = 0.0
    diversity_score: float = 0.0
    task_evidence_score: float = 0.0
    missing_areas: list[str] = Field(default_factory=list)
    reason: str = ""


class PanelRecommendation(BaseModel):
    target_profile: PanelProfile
    members: list[PanelRecommendationMember]
    objective_score: float
    warnings: list[str] = Field(default_factory=list)


class SourceFetchResult(BaseModel):
    source: LiveSource
    url: str
    availability: SourceAvailability = "ran"
    snapshot_hash: str
    retrieved_at: str
    record_count: int
    error_reason: str | None = None


class LiveFetchResult(BaseModel):
    scores: list[ModelAreaScore]
    sources: list[SourceFetchResult]


class ValidationIssue(BaseModel):
    severity: ValidationSeverity
    code: str
    message: str
    model_key: str | None = None
    benchmark: str | None = None
    area: str | None = None
    source_url: str | None = None


class DataQualityReport(BaseModel):
    checked_rows: int
    error_count: int
    warning_count: int
    issue_counts: dict[str, int] = Field(default_factory=dict)
    area_counts: dict[str, int] = Field(default_factory=dict)
    source_counts: dict[str, int] = Field(default_factory=dict)
    issues: list[ValidationIssue] = Field(default_factory=list)


class FetchError(RuntimeError):
    """A live public benchmark source could not be fetched or parsed."""


SourceParser = Callable[[str, str, str, str, int | None], list[ModelAreaScore]]


@dataclass(frozen=True)
class SourceSpec:
    """Description and parser binding for one live model-area source."""

    source: LiveSource
    url: str
    parser: SourceParser
    areas: tuple[str, ...]
    description: str


SOURCE_PARSERS: dict[LiveSource, SourceParser] = {}
SOURCE_DESCRIPTIONS: dict[LiveSource, str] = {
    "aider": "Aider polyglot coding-edit leaderboard.",
    "swe_bench": "SWE-bench leaderboard JSON for repository repair tasks.",
    "terminal_bench": "Terminal-Bench 2.1 rendered leaderboard data.",
    "livecodebench_generation": "LiveCodeBench code-generation raw performances.",
    "livecodebench_execution": "LiveCodeBench code-execution raw performances.",
    "livecodebench_repair": "LiveCodeBench code-repair raw performances.",
    "livecodebench_testgen": "LiveCodeBench test-generation raw performances.",
    "benchlm": "BenchLM broad category leaderboard JSON.",
    "open_llm_leaderboard": "Hugging Face Open LLM Leaderboard formatted API.",
    "uibenchkit_dcgen": "UIBenchKit DCGen UI-to-code leaderboard CSV.",
    "uibenchkit_design2code": "UIBenchKit Design2Code leaderboard CSV.",
}


def register_source(spec: SourceSpec) -> None:
    """Register or replace a live source.

    External callers can extend the package without editing the built-in
    dispatch path by providing a source id, URL, parser, and advertised areas.
    """

    if not spec.source:
        raise ValueError("source id must not be empty")
    if not spec.url:
        raise ValueError(f"source {spec.source!r} must have a URL")
    if not spec.areas:
        raise ValueError(f"source {spec.source!r} must advertise at least one area")
    SOURCE_URLS[spec.source] = spec.url
    SOURCE_AREAS[spec.source] = spec.areas
    SOURCE_DESCRIPTIONS[spec.source] = spec.description
    SOURCE_PARSERS[spec.source] = spec.parser
    _refresh_live_sources()


def get_source_spec(source: LiveSource) -> SourceSpec:
    try:
        return SourceSpec(
            source=source,
            url=SOURCE_URLS[source],
            parser=SOURCE_PARSERS[source],
            areas=SOURCE_AREAS[source],
            description=SOURCE_DESCRIPTIONS.get(source, ""),
        )
    except KeyError as exc:
        known = ", ".join(LIVE_SOURCES)
        raise KeyError(f"unknown model-area source {source!r}; known sources: {known}") from exc


def get_source_specs() -> tuple[SourceSpec, ...]:
    return tuple(get_source_spec(source) for source in LIVE_SOURCES)


def _refresh_live_sources() -> None:
    global LIVE_SOURCES
    LIVE_SOURCES = tuple(SOURCE_URLS)


def fetch_live_model_area_scores(
    sources: Sequence[LiveSource] = LIVE_SOURCES,
    *,
    timeout_s: float = 30.0,
    limit_per_source: int | None = None,
    strict: bool = False,
) -> LiveFetchResult:
    all_scores: list[ModelAreaScore] = []
    fetch_results: list[SourceFetchResult] = []
    for source in sources:
        retrieved_at = datetime.now(UTC).isoformat(timespec="seconds")
        try:
            spec = get_source_spec(source)
            url = spec.url
            raw = _fetch_url(url, timeout_s=timeout_s)
            snapshot_hash = hashlib.sha256(raw).hexdigest()
            text = raw.decode("utf-8", errors="replace")
            scores = spec.parser(text, url, snapshot_hash, retrieved_at, limit_per_source)
        except FetchError as exc:
            if strict:
                raise
            fetch_results.append(
                SourceFetchResult(
                    source=source,
                    url=SOURCE_URLS.get(source, ""),
                    availability="failed",
                    snapshot_hash="",
                    retrieved_at=retrieved_at,
                    record_count=0,
                    error_reason=str(exc),
                )
            )
            continue
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            if strict:
                raise FetchError(f"source {source!r} failed: {exc}") from exc
            fetch_results.append(
                SourceFetchResult(
                    source=source,
                    url=SOURCE_URLS.get(source, ""),
                    availability="failed",
                    snapshot_hash="",
                    retrieved_at=retrieved_at,
                    record_count=0,
                    error_reason=str(exc),
                )
            )
            continue
        all_scores.extend(scores)
        fetch_results.append(
            SourceFetchResult(
                source=source,
                url=url,
                availability="ran",
                snapshot_hash=snapshot_hash,
                retrieved_at=retrieved_at,
                record_count=len(scores),
            )
        )
    return LiveFetchResult(scores=all_scores, sources=fetch_results)


def load_model_area_scores(path: str | Path) -> list[ModelAreaScore]:
    return [ModelAreaScore.model_validate(row) for row in _load_records(path)]


def load_task_outcomes(path: str | Path) -> list[TaskOutcome]:
    return [TaskOutcome.model_validate(row) for row in _load_records(path)]


def write_task_outcomes(path: str | Path, outcomes: Iterable[TaskOutcome]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for outcome in outcomes:
            handle.write(json.dumps(outcome.model_dump(mode="json"), sort_keys=True) + "\n")


def write_model_area_scores(path: str | Path, scores: Iterable[ModelAreaScore]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for score in scores:
            handle.write(json.dumps(score.model_dump(mode="json"), sort_keys=True) + "\n")


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


def build_task_outcome_reports(
    outcomes: Sequence[TaskOutcome],
    *,
    model_keys: Sequence[str] | None = None,
) -> list[TaskOutcomePanelMetrics]:
    grouped: dict[tuple[str, str], list[TaskOutcome]] = {}
    for outcome in outcomes:
        grouped.setdefault((outcome.benchmark, outcome.benchmark_version), []).append(outcome)
    return [
        build_task_outcome_panel_metrics(group_outcomes, model_keys=model_keys)
        for _, group_outcomes in sorted(grouped.items())
    ]


def build_data_quality_report(
    scores: Sequence[ModelAreaScore],
    *,
    max_issues: int = 200,
) -> DataQualityReport:
    """Validate normalized rows before they are trusted as matrix input."""

    issues: list[ValidationIssue] = []
    area_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    seen_keys: set[tuple[str, str, str, str, str | None, str]] = set()
    known_urls = {spec.url: spec for spec in get_source_specs()}

    for score in scores:
        area_counts[score.area] = area_counts.get(score.area, 0) + 1
        source_counts[score.source_url] = source_counts.get(score.source_url, 0) + 1
        spec = known_urls.get(score.source_url)
        if spec is None:
            _add_issue(
                issues,
                ValidationIssue(
                    severity="warning",
                    code="unknown_source_url",
                    message="row source URL is not registered",
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        elif score.area not in spec.areas:
            _add_issue(
                issues,
                ValidationIssue(
                    severity="error",
                    code="source_area_mismatch",
                    message=(
                        f"source {spec.source!r} emitted unexpected area {score.area!r}"
                    ),
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        if score.provider == "unknown":
            _add_issue(
                issues,
                ValidationIssue(
                    severity="warning",
                    code="unknown_provider",
                    message="provider could not be inferred from public row",
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        if score.data_level == "task_outcome" and not score.same_harness_comparable:
            _add_issue(
                issues,
                ValidationIssue(
                    severity="error",
                    code="task_outcome_not_same_harness",
                    message="task_outcome rows must be same-harness comparable",
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        if score.n_tasks is None and score.data_level in ("task_outcome", "subtask"):
            _add_issue(
                issues,
                ValidationIssue(
                    severity="warning",
                    code="missing_task_count",
                    message="higher-evidence row is missing n_tasks",
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        key = (
            score.model_key,
            score.benchmark,
            score.benchmark_version,
            score.area,
            score.subarea,
            score.source_snapshot_hash,
        )
        if key in seen_keys:
            _add_issue(
                issues,
                ValidationIssue(
                    severity="warning",
                    code="duplicate_row",
                    message="duplicate model/benchmark/version/area/subarea/source row",
                    model_key=score.model_key,
                    benchmark=score.benchmark,
                    area=score.area,
                    source_url=score.source_url,
                ),
                max_issues,
            )
        seen_keys.add(key)

    issue_counts: dict[str, int] = {}
    for issue in issues:
        issue_counts[issue.code] = issue_counts.get(issue.code, 0) + 1
    return DataQualityReport(
        checked_rows=len(scores),
        error_count=sum(1 for issue in issues if issue.severity == "error"),
        warning_count=sum(1 for issue in issues if issue.severity == "warning"),
        issue_counts=issue_counts,
        area_counts=dict(sorted(area_counts.items())),
        source_counts=dict(sorted(source_counts.items())),
        issues=issues,
    )


def recommend_panel(
    matrix: ModelAreaMatrix,
    *,
    target_profile: PanelProfile = "coding-agent",
    max_members: int = 3,
    max_cost_usd: float | None = None,
    require_provider_diversity: bool = True,
    task_outcome_metrics: Sequence[TaskOutcomePanelMetrics] = (),
    similarity_penalty: float = 0.25,
) -> PanelRecommendation:
    if max_members < 1:
        raise ValueError("max_members must be at least 1")
    area_weights = PROFILE_AREA_WEIGHTS[target_profile]
    candidate_scores: dict[str, PanelRecommendationMember] = {}
    for row in matrix.rows.values():
        candidate = _score_recommendation_candidate(row, area_weights, max_cost_usd)
        if candidate is not None:
            candidate_scores[row.model_key] = candidate
    eligible = list(candidate_scores.values())
    selected: list[PanelRecommendationMember] = []
    seen_providers: set[str] = set()
    warnings = []
    task_scores = _task_metric_member_scores(task_outcome_metrics)
    while len(selected) < max_members and eligible:
        best_index: int | None = None
        best_member: PanelRecommendationMember | None = None
        for index, candidate in enumerate(eligible):
            if require_provider_diversity and candidate.provider in seen_providers:
                continue
            diversity_score = _candidate_diversity_score(
                matrix,
                candidate.model_key,
                [member.model_key for member in selected],
            )
            task_evidence_score = task_scores.get(candidate.model_key, 0.0)
            score = (
                candidate.capability_score
                + similarity_penalty * diversity_score
                + 0.35 * task_evidence_score
            )
            member = candidate.model_copy(
                update={
                    "score": score,
                    "diversity_score": diversity_score,
                    "task_evidence_score": task_evidence_score,
                    "reason": _recommendation_reason(diversity_score, task_evidence_score),
                }
            )
            if best_member is None or member.score > best_member.score:
                best_index = index
                best_member = member
        if best_member is None:
            break
        selected.append(best_member)
        seen_providers.add(best_member.provider)
        del eligible[best_index if best_index is not None else 0]
    if len(selected) < max_members and require_provider_diversity:
        warnings.append("provider-diversity constraint limited panel size")
        while len(selected) < max_members and eligible:
            # Relax provider diversity only after recording the constraint warning.
            best_index = max(
                range(len(eligible)),
                key=lambda index: _candidate_diversity_score(
                    matrix,
                    eligible[index].model_key,
                    [member.model_key for member in selected],
                ) + eligible[index].capability_score,
            )
            candidate = eligible.pop(best_index)
            diversity_score = _candidate_diversity_score(
                matrix,
                candidate.model_key,
                [member.model_key for member in selected],
            )
            task_evidence_score = task_scores.get(candidate.model_key, 0.0)
            selected.append(
                candidate.model_copy(
                    update={
                        "score": (
                            candidate.capability_score
                            + similarity_penalty * diversity_score
                            + 0.35 * task_evidence_score
                        ),
                        "diversity_score": diversity_score,
                        "task_evidence_score": task_evidence_score,
                        "reason": _recommendation_reason(diversity_score, task_evidence_score),
                    }
                )
            )
    if len(selected) < max_members:
        warnings.append("fewer eligible models than requested after constraints")
    if any(member.missing_areas for member in selected):
        warnings.append("one or more selected models lack evidence for profile areas")
    if not task_outcome_metrics:
        warnings.append("no task-outcome metrics supplied; diversity uses capability-vector proxy")
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


def _fetch_url(url: str, *, timeout_s: float) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urlopen(request, timeout=timeout_s) as response:
            return response.read()
    except (HTTPError, URLError, TimeoutError) as exc:
        raise FetchError(f"failed to fetch {url}: {exc}") from exc


def _parse_aider(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    rows: list[ModelAreaScore] = []
    for block in re.findall(r'<tr class="details-row".*?</tr>', text, re.S):
        fields = _parse_aider_fields(block)
        model = fields.get("Model")
        pass_rate = _as_float(fields.get("Pass rate 2"))
        if model is None or pass_rate is None:
            continue
        n_tasks = _as_int(fields.get("Test cases")) or _as_int(fields.get("Total tests"))
        rows.append(
            ModelAreaScore(
                model_key=_model_key(model),
                provider=_provider_for_name(model),
                model_family=_family_for_name(model),
                model_version_or_alias=model,
                benchmark="aider-polyglot",
                benchmark_version=fields.get("Date") or "live",
                area="coding_edit",
                subarea="polyglot_exercism",
                score_raw=pass_rate / 100.0,
                n_tasks=n_tasks,
                cost_usd=_as_float(fields.get("Total cost")),
                date_observed=retrieved_at,
                harness="aider benchmark",
                prompting_mode=fields.get("Command"),
                source_url=source_url,
                source_snapshot_hash=snapshot_hash,
                data_level="aggregate",
                scoring="deterministic_tests",
                saturation_weight=_saturation_weight(pass_rate / 100.0),
                same_harness_comparable=True,
            )
        )
        if limit is not None and len(rows) >= limit:
            break
    if not rows:
        raise FetchError("Aider leaderboard parsed zero rows")
    return rows


def _parse_aider_fields(block: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for key, value in re.findall(r"<li><strong>\s*(.*?)\s*:</strong>\s*(.*?)\s*</li>", block, re.S):
        clean_key = _strip_html(key)
        clean_value = _strip_html(value)
        if clean_key:
            fields[clean_key] = clean_value
    return fields


def _parse_swe_bench(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    parsed = json.loads(text)
    rows: list[ModelAreaScore] = []
    for leaderboard in parsed.get("leaderboards", []):
        if not isinstance(leaderboard, Mapping):
            continue
        suite = str(leaderboard.get("name", "unknown"))
        results = leaderboard.get("results", [])
        if not isinstance(results, list):
            continue
        for result in results[:limit]:
            if not isinstance(result, Mapping):
                continue
            name = _as_str(result.get("name"))
            resolved = _as_float(result.get("resolved"))
            if name is None or resolved is None:
                continue
            details = result.get("per_instance_details")
            n_tasks = len(details) if isinstance(details, Mapping) else SWE_TASK_COUNTS.get(suite)
            rows.append(
                ModelAreaScore(
                    model_key=_model_key(name),
                    provider=_provider_for_name(name),
                    model_family=_family_for_name(name),
                    model_version_or_alias=name,
                    benchmark="swe-bench",
                    benchmark_version=suite,
                    area="swe_repair",
                    subarea=suite,
                    score_raw=resolved / 100.0,
                    n_tasks=n_tasks,
                    cost_usd=_as_float(result.get("cost")),
                    date_observed=retrieved_at,
                    harness=f"SWE-bench {suite} leaderboard",
                    prompting_mode="agent_system" if result.get("os_system") is not None else None,
                    source_url=source_url,
                    source_snapshot_hash=snapshot_hash,
                    data_level="aggregate",
                    scoring="deterministic_tests",
                    saturation_weight=_saturation_weight(resolved / 100.0),
                    same_harness_comparable=False,
                )
            )
    if not rows:
        raise FetchError("SWE-bench leaderboard parsed zero rows")
    return rows


def _parse_terminal_bench(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    rows_json = _extract_terminal_rows_json(text)
    rows: list[ModelAreaScore] = []
    for entry in rows_json[:limit]:
        if not isinstance(entry, Mapping):
            continue
        accuracy = _as_float(entry.get("accuracy"))
        model_names = entry.get("modelNames")
        display_names = entry.get("model")
        if accuracy is None or not isinstance(model_names, list) or not model_names:
            continue
        model_name = "+".join(str(model) for model in model_names)
        display_name = (
            " + ".join(str(model) for model in display_names)
            if isinstance(display_names, list) and display_names
            else model_name
        )
        provider_values = entry.get("modelProviders")
        provider = (
            str(provider_values[0])
            if isinstance(provider_values, list) and provider_values
            else _provider_for_name(model_name)
        )
        agent = _as_str(entry.get("agent"))
        rows.append(
            ModelAreaScore(
                model_key=_model_key(model_name),
                provider=provider.lower(),
                model_family=_family_for_name(model_name),
                model_version_or_alias=display_name,
                benchmark="terminal-bench",
                benchmark_version="2.1",
                area="terminal_agentic",
                subarea="verified_terminal_tasks",
                score_raw=accuracy,
                stderr_or_ci=_as_float(entry.get("stderr")),
                date_observed=retrieved_at,
                harness="Terminal-Bench 2.1 leaderboard",
                prompting_mode=f"agent={agent}" if agent else "agent_plus_model",
                source_url=source_url,
                source_snapshot_hash=snapshot_hash,
                data_level="aggregate",
                scoring="deterministic_tests",
                saturation_weight=_saturation_weight(accuracy),
                same_harness_comparable=False,
            )
        )
    if not rows:
        raise FetchError("Terminal-Bench leaderboard parsed zero rows")
    return rows


def _extract_terminal_rows_json(text: str) -> list[Any]:
    marker = r'\"rows\":'
    start = text.find(marker)
    if start == -1:
        raise FetchError("Terminal-Bench page did not contain embedded rows")
    start += len(marker)
    array_start = text.find("[", start)
    if array_start == -1:
        raise FetchError("Terminal-Bench rows marker was not followed by an array")
    depth = 0
    array_end: int | None = None
    for index in range(array_start, len(text)):
        char = text[index]
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                array_end = index + 1
                break
    if array_end is None:
        raise FetchError("Terminal-Bench embedded rows array was unterminated")
    raw_array = text[array_start:array_end].replace(r"\"", '"').replace(r"\/", "/")
    parsed = json.loads(raw_array)
    if not isinstance(parsed, list):
        raise FetchError("Terminal-Bench embedded rows were not a JSON list")
    return parsed


def _parse_livecodebench(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
    *,
    benchmark_version: str,
    area: str,
    default_subarea: str,
    metric_key: str,
    fallback_metric_key: str | None = None,
) -> list[ModelAreaScore]:
    parsed = json.loads(text)
    performances = parsed.get("performances")
    if not isinstance(performances, list):
        raise FetchError("LiveCodeBench performances_generation JSON lacked performances")
    by_model: dict[str, list[float]] = {}
    difficulty_scores: dict[tuple[str, str], list[float]] = {}
    for row in performances:
        if not isinstance(row, Mapping):
            continue
        model = _as_str(row.get("model"))
        score = _as_float(row.get(metric_key))
        if score is None and fallback_metric_key is not None:
            score = _as_float(row.get(fallback_metric_key))
        if model is None or score is None:
            continue
        normalized = score / 100.0 if score > 1.0 else score
        by_model.setdefault(model, []).append(normalized)
        difficulty = _as_str(row.get("difficulty"))
        if difficulty is not None:
            difficulty_scores.setdefault((model, difficulty), []).append(normalized)
    ranked = sorted(by_model.items(), key=lambda item: _average(item[1]), reverse=True)
    rows: list[ModelAreaScore] = []
    for model, scores in ranked[:limit]:
        rows.append(
            ModelAreaScore(
                model_key=_model_key(model),
                provider=_provider_for_name(model),
                model_family=_family_for_name(model),
                model_version_or_alias=model,
                benchmark="livecodebench",
                benchmark_version=benchmark_version,
                area=area,
                subarea=default_subarea,
                score_raw=_average(scores),
                n_tasks=len(scores),
                date_observed=retrieved_at,
                harness=f"LiveCodeBench {benchmark_version} raw performances",
                prompting_mode="single_attempt",
                source_url=source_url,
                source_snapshot_hash=snapshot_hash,
                data_level="subtask",
                scoring="deterministic_tests",
                saturation_weight=_saturation_weight(_average(scores)),
                same_harness_comparable=True,
            )
        )
        for difficulty in ("easy", "medium", "hard"):
            diff_values = difficulty_scores.get((model, difficulty), [])
            if not diff_values:
                continue
            rows.append(
                ModelAreaScore(
                    model_key=_model_key(model),
                    provider=_provider_for_name(model),
                    model_family=_family_for_name(model),
                    model_version_or_alias=model,
                    benchmark="livecodebench",
                    benchmark_version=benchmark_version,
                    area=area,
                    subarea=f"{difficulty}_pass_at_1",
                    score_raw=_average(diff_values),
                    n_tasks=len(diff_values),
                    date_observed=retrieved_at,
                    harness=f"LiveCodeBench {benchmark_version} raw performances",
                    prompting_mode="single_attempt",
                    source_url=source_url,
                    source_snapshot_hash=snapshot_hash,
                    data_level="subtask",
                    scoring="deterministic_tests",
                    saturation_weight=_saturation_weight(_average(diff_values)),
                    same_harness_comparable=True,
                )
            )
    if not rows:
        raise FetchError("LiveCodeBench raw performances parsed zero rows")
    return rows


def _parse_benchlm(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    parsed = json.loads(text)
    rows: list[ModelAreaScore] = []
    categories = parsed.get("categories")
    if isinstance(categories, Mapping):
        for category, area in BENCHLM_CATEGORY_AREAS.items():
            entries = categories.get(category, [])
            if not isinstance(entries, list):
                continue
            for item in entries[:limit]:
                if not isinstance(item, Mapping):
                    continue
                score = _as_float(item.get("score"))
                if score is None:
                    continue
                rows.append(
                    _benchlm_score(
                        item,
                        area=area,
                        category=category,
                        score=score,
                        parsed=parsed,
                        source_url=source_url,
                        snapshot_hash=snapshot_hash,
                        retrieved_at=retrieved_at,
                    )
                )
    else:
        items = parsed.get("items", [])
        if not isinstance(items, list):
            raise FetchError("BenchLM leaderboard JSON lacked items or categories")
        for item in items[:limit]:
            if not isinstance(item, Mapping):
                continue
            category_scores = item.get("categoryScores")
            if not isinstance(category_scores, Mapping):
                continue
            for category, area in BENCHLM_CATEGORY_AREAS.items():
                score = _as_float(category_scores.get(category))
                if score is None:
                    continue
                rows.append(
                    _benchlm_score(
                        item,
                        area=area,
                        category=category,
                        score=score,
                        parsed=parsed,
                        source_url=source_url,
                        snapshot_hash=snapshot_hash,
                        retrieved_at=retrieved_at,
                    )
                )
    if not rows:
        raise FetchError("BenchLM leaderboard parsed zero rows")
    return rows


def _benchlm_score(
    item: Mapping[str, object],
    *,
    area: str,
    category: str,
    score: float,
    parsed: Mapping[str, object],
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
) -> ModelAreaScore:
    model = _as_str(item.get("model"))
    if model is None:
        raise FetchError("BenchLM row lacked model")
    normalized = score / 100.0 if score > 1.0 else score
    confidence = _as_float(item.get("scoreConfidence"))
    return ModelAreaScore(
        model_key=_model_key(model),
        provider=_provider_for_name(_as_str(item.get("creator")) or model),
        model_family=_family_for_name(model),
        model_version_or_alias=model,
        benchmark="benchlm",
        benchmark_version=str(parsed.get("sourceLastUpdated") or "live"),
        area=area,
        subarea=category,
        score_raw=normalized,
        score_normalized=normalized,
        n_tasks=_positive_int_or_none(item.get("trustedBenchmarkCount")),
        date_observed=retrieved_at,
        harness="BenchLM category leaderboard",
        prompting_mode="mixed_public_benchmarks",
        source_url=source_url,
        source_snapshot_hash=snapshot_hash,
        data_level="aggregate",
        scoring="objective",
        freshness_weight=min(1.0, 0.35 + (confidence or 1.0) * 0.2),
        saturation_weight=_saturation_weight(normalized),
        same_harness_comparable=False,
    )


def _parse_open_llm_leaderboard(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise FetchError("Open LLM Leaderboard formatted API did not return a list")
    rows: list[ModelAreaScore] = []
    for entry in parsed[:limit]:
        if not isinstance(entry, Mapping):
            continue
        model_block = entry.get("model")
        evaluations = entry.get("evaluations")
        if not isinstance(model_block, Mapping) or not isinstance(evaluations, Mapping):
            continue
        model = _as_str(model_block.get("name"))
        if model is None:
            continue
        for eval_key, area in OPEN_LLM_EVAL_AREAS.items():
            eval_block = evaluations.get(eval_key)
            if not isinstance(eval_block, Mapping):
                continue
            score = _as_float(eval_block.get("value"))
            normalized_score = _as_float(eval_block.get("normalized_score"))
            if score is None:
                continue
            rows.append(
                ModelAreaScore(
                    model_key=_model_key(model),
                    provider="open-weight",
                    model_family=_family_for_name(model),
                    model_version_or_alias=model,
                    benchmark="open-llm-leaderboard",
                    benchmark_version="formatted-live",
                    area=area,
                    subarea=eval_key,
                    score_raw=score,
                    score_normalized=(
                        normalized_score / 100.0 if normalized_score is not None else None
                    ),
                    date_observed=retrieved_at,
                    harness="Open LLM Leaderboard formatted API",
                    prompting_mode="leaderboard_v2",
                    source_url=source_url,
                    source_snapshot_hash=snapshot_hash,
                    data_level="aggregate",
                    scoring="objective",
                    saturation_weight=_saturation_weight(score),
                    same_harness_comparable=True,
                )
            )
    if not rows:
        raise FetchError("Open LLM Leaderboard parsed zero rows")
    return rows


def _parse_uibenchkit(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    csv_rows = list(csv.DictReader(io.StringIO(text)))
    rows: list[ModelAreaScore] = []
    for entry in csv_rows[:limit]:
        model = entry.get("model")
        dataset = entry.get("dataset") or "ui"
        if not model:
            continue
        metric_values = {
            "ui_to_code": _mean_present(
                [
                    _as_float(entry.get("clip_avg")),
                    _as_float(entry.get("fg_block_match_avg")),
                    _as_float(entry.get("fg_text_avg")),
                    _as_float(entry.get("fg_position_avg")),
                    _as_float(entry.get("fg_color_avg")),
                    _as_float(entry.get("fg_clip_avg")),
                ]
            ),
            "ui_visual_fidelity": _as_float(entry.get("clip_avg")),
            "ui_layout_structure": _mean_present(
                [
                    _as_float(entry.get("fg_block_match_avg")),
                    _as_float(entry.get("fg_position_avg")),
                ]
            ),
            "ui_text_fidelity": _as_float(entry.get("fg_text_avg")),
            "ui_color_fidelity": _as_float(entry.get("fg_color_avg")),
        }
        for area, score in metric_values.items():
            if score is None:
                continue
            rows.append(
                ModelAreaScore(
                    model_key=_model_key(model),
                    provider=_provider_for_name(model),
                    model_family=_family_for_name(model),
                    model_version_or_alias=model,
                    benchmark="uibenchkit",
                    benchmark_version=str(dataset),
                    area=area,
                    subarea=entry.get("method") or str(dataset),
                    score_raw=score,
                    score_normalized=score,
                    n_tasks=UIBENCHKIT_TASK_COUNTS.get(str(dataset)),
                    cost_usd=None,
                    date_observed=retrieved_at,
                    harness=f"UIBenchKit {dataset} leaderboard",
                    prompting_mode=entry.get("method"),
                    source_url=source_url,
                    source_snapshot_hash=snapshot_hash,
                    data_level="aggregate",
                    scoring="objective",
                    saturation_weight=_saturation_weight(score),
                    same_harness_comparable=True,
                )
            )
    if not rows:
        raise FetchError("UIBenchKit leaderboard parsed zero rows")
    return rows


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


def _add_issue(
    issues: list[ValidationIssue],
    issue: ValidationIssue,
    max_issues: int,
) -> None:
    if len(issues) < max_issues:
        issues.append(issue)


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
    if len({record.source_snapshot_hash for record in records}) == 1:
        warnings.append("single-source cell; corroborate before making claims")
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
        capability_score=max(0.0, score),
        missing_areas=missing_areas,
    )


def _candidate_diversity_score(
    matrix: ModelAreaMatrix,
    model_key: str,
    selected_model_keys: Sequence[str],
) -> float:
    if not selected_model_keys:
        return 1.0
    candidate_vector = _model_vector(matrix, model_key)
    similarities = [
        _cosine_similarity(candidate_vector, _model_vector(matrix, selected_key))
        for selected_key in selected_model_keys
    ]
    return max(0.0, 1.0 - max(similarities))


def _model_vector(matrix: ModelAreaMatrix, model_key: str) -> list[float]:
    row = matrix.rows.get(model_key)
    if row is None:
        return [0.0 for _ in matrix.areas]
    values: list[float] = []
    for area in matrix.areas:
        cell = row.cells.get(area)
        values.append(
            cell.normalized_score
            if cell is not None and cell.normalized_score is not None
            else 0.0
        )
    return values


def _cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    numerator = sum(
        left_value * right_value
        for left_value, right_value in zip(left, right, strict=True)
    )
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return numerator / (left_norm * right_norm)


def _task_metric_member_scores(
    metrics: Sequence[TaskOutcomePanelMetrics],
) -> dict[str, float]:
    scores: dict[str, float] = {}
    for metric in metrics:
        if metric.decorrelation_evidence_level != "task_vector":
            continue
        headroom = max(0.0, metric.oracle_headroom or 0.0)
        mean_corr = _mean_failure_correlation(metric.failure_correlations)
        decorrelation = 1.0 - mean_corr if mean_corr is not None else 0.5
        for model_key in metric.model_keys:
            unique_win = metric.unique_win_rates.get(model_key, 0.0)
            scores[model_key] = max(
                scores.get(model_key, 0.0),
                min(1.0, 0.45 * decorrelation + 0.35 * unique_win + 0.2 * headroom),
            )
    return scores


def _mean_failure_correlation(rows: Sequence[FailureCorrelation]) -> float | None:
    values = [row.correlation for row in rows if row.correlation is not None]
    if not values:
        return None
    return _average(values)


def _recommendation_reason(diversity_score: float, task_evidence_score: float) -> str:
    if task_evidence_score > 0:
        return "task-outcome evidence plus capability/diversity score"
    if diversity_score < 0.25:
        return "capability score with low proxy diversity"
    return "capability score with aggregate proxy diversity"


def _strip_html(value: str) -> str:
    return html.unescape(re.sub(r"<.*?>", "", value)).strip()


def _model_key(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "unknown-model"


def _provider_for_name(value: str) -> str:
    lower = value.lower()
    if any(token in lower for token in ("claude", "anthropic")):
        return "anthropic"
    if any(token in lower for token in ("gemini", "google")):
        return "google"
    if any(token in lower for token in ("deepseek", "r1")):
        return "deepseek"
    if any(token in lower for token in ("qwen", "dashscope", "alibaba")):
        return "alibaba"
    if any(token in lower for token in ("grok", "x-ai", "xai")):
        return "xai"
    if any(token in lower for token in ("llama", "mistral", "mixtral", "glm", "minimax")):
        return "open-weight"
    if any(token in lower for token in ("gpt", "openai", "o1", "o3", "o4", "codex")):
        return "openai"
    return "unknown"


def _family_for_name(value: str) -> str:
    lower = value.lower()
    if "claude" in lower:
        return "claude"
    if "gemini" in lower:
        return "gemini"
    if "deepseek" in lower:
        return "deepseek"
    if "codex" in lower:
        return "codex"
    if "gpt" in lower:
        return "gpt"
    if re.search(r"\bo[134]\b|o[134]-", lower):
        return "o-series"
    if "llama" in lower:
        return "llama"
    if "qwen" in lower:
        return "qwen"
    if "glm" in lower:
        return "glm"
    return _model_key(value).split("-")[0]


def _saturation_weight(score: float) -> float:
    if score > 0.9:
        return 0.45
    if score > 0.8:
        return 0.7
    return 1.0


def _as_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().rstrip("%"))
        except ValueError:
            return None
    return None


def _as_int(value: object) -> int | None:
    number = _as_float(value)
    return int(number) if number is not None else None


def _positive_int_or_none(value: object) -> int | None:
    number = _as_int(value)
    return number if number is not None and number >= 1 else None


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


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


def _mean_present(values: Sequence[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return _average(present) if present else None


def _format_cell(cell: AreaMatrixCell | None) -> str:
    if cell is None or cell.normalized_score is None:
        return "-"
    return f"{cell.normalized_score:.3f} ({cell.confidence:.2f})"


def _register_builtin_sources() -> None:
    parsers: dict[LiveSource, SourceParser] = {
        "aider": _parse_aider,
        "swe_bench": _parse_swe_bench,
        "terminal_bench": _parse_terminal_bench,
        "livecodebench_generation": _parse_livecodebench_generation,
        "livecodebench_execution": _parse_livecodebench_execution,
        "livecodebench_repair": _parse_livecodebench_repair,
        "livecodebench_testgen": _parse_livecodebench_testgen,
        "benchlm": _parse_benchlm,
        "open_llm_leaderboard": _parse_open_llm_leaderboard,
        "uibenchkit_dcgen": _parse_uibenchkit,
        "uibenchkit_design2code": _parse_uibenchkit,
    }
    for source, parser in parsers.items():
        register_source(
            SourceSpec(
                source=source,
                url=SOURCE_URLS[source],
                parser=parser,
                areas=SOURCE_AREAS[source],
                description=SOURCE_DESCRIPTIONS[source],
            )
        )


def _parse_livecodebench_generation(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    return _parse_livecodebench(
        text,
        source_url,
        snapshot_hash,
        retrieved_at,
        limit,
        benchmark_version="generation-live",
        area="competitive_programming",
        default_subarea="pass_at_1",
        metric_key="pass@1",
    )


def _parse_livecodebench_execution(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    return _parse_livecodebench(
        text,
        source_url,
        snapshot_hash,
        retrieved_at,
        limit,
        benchmark_version="execution-live",
        area="code_execution",
        default_subarea="pass_at_1_cot",
        metric_key="Pass@1-COT",
        fallback_metric_key="Pass@1",
    )


def _parse_livecodebench_repair(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    return _parse_livecodebench(
        text,
        source_url,
        snapshot_hash,
        retrieved_at,
        limit,
        benchmark_version="repair-live",
        area="code_repair",
        default_subarea="pass_at_1",
        metric_key="pass@1",
    )


def _parse_livecodebench_testgen(
    text: str,
    source_url: str,
    snapshot_hash: str,
    retrieved_at: str,
    limit: int | None,
) -> list[ModelAreaScore]:
    return _parse_livecodebench(
        text,
        source_url,
        snapshot_hash,
        retrieved_at,
        limit,
        benchmark_version="testgen-live",
        area="test_generation",
        default_subarea="pass_at_1",
        metric_key="pass@1",
    )


_register_builtin_sources()
