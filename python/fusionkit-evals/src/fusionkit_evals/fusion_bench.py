from __future__ import annotations

import asyncio
import html
import json
import math
import os
import platform
import shlex
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from fusionkit_core.artifacts import LocalArtifactStore, hash_text
from fusionkit_core.config import FusionMode
from fusionkit_core.contracts import (
    ArtifactRefV1,
    BenchmarkTaskRecordV1,
    ContractArtifactRef,
    ContractError,
    FusionRecordV1,
    FusionRunRequestV1,
    JudgeSynthesisRecordV1,
    ModelCallRecordV1,
    contract_metadata,
    contract_model_for_schema,
    producer_git_sha,
    schema_bundle_hash,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import FusionRunManager, RunInspection
from fusionkit_core.run_store import FileSystemRunStore
from pydantic import BaseModel, Field

from fusionkit_evals.scorers import contains_expected, exact_match
from fusionkit_evals.tiny import TINY_FIXTURE_ROOT

FUSION_BENCH_DISCLAIMER = (
    "internal fusion-bench report; not public benchmark performance unless public task "
    "suites were run"
)

FailureKind = Literal[
    "none",
    "unavailable_provider",
    "unavailable_harness",
    "run_failed",
    "validation_error",
    "unsupported_task_kind",
]
HarnessVerificationOutcome = Literal["succeeded", "failed", "skipped", "unknown"]
ParetoAxis = Literal["quality_cost", "quality_latency"]

SKIPPED_FAILURE_KINDS = {
    "unavailable_provider",
    "unavailable_harness",
    "unsupported_task_kind",
}


class FusionBenchTask(BaseModel):
    category: str
    path: Path
    record: BenchmarkTaskRecordV1


class FusionBenchFailure(BaseModel):
    failure_kind: FailureKind = "none"
    error_code: str | None = None
    owner: str | None = None
    retryable: bool = False
    terminal_reason: str | None = None


class FusionBenchAttemptRow(BaseModel):
    task_id: str
    category: str
    task_kind: str
    manifest_path: str
    manifest_hash: str
    schema_bundle_hash: str
    repo_sha: str
    config_id: str
    mode: str | None = None
    model_versions: dict[str, str] = Field(default_factory=dict)
    run_id: str | None = None
    trace_id: str | None = None
    state: str | None = None
    status: str | None = None
    output: str | None = None
    failure: FusionBenchFailure = Field(default_factory=FusionBenchFailure)
    task_record: dict[str, Any]
    harness_run_result: dict[str, Any] | None = None
    harness_candidate_records: list[dict[str, Any]] = Field(default_factory=list)
    fusion_record: dict[str, Any] | None = None
    model_call_records: list[dict[str, Any]] = Field(default_factory=list)
    judge_synthesis_record: dict[str, Any] | None = None
    artifact_records: list[dict[str, Any]] = Field(default_factory=list)
    tool_records: list[dict[str, Any]] = Field(default_factory=list)
    receipt_records: list[dict[str, Any]] = Field(default_factory=list)
    provider_metadata: list[dict[str, Any]] = Field(default_factory=list)
    model_ids: list[str] = Field(default_factory=list)
    cost_estimate: float | None = None
    latency_s: float | None = None


class FusionBenchTaskMetrics(BaseModel):
    task_id: str
    category: str
    config_id: str
    mode: str | None = None
    status: str | None = None
    failure_kind: str = "none"
    skipped: bool = False
    failed: bool = False
    harness_verification_outcome: HarnessVerificationOutcome = "unknown"
    synthesized_success: float | None = None
    best_single_success: float | None = None
    random_success: float | None = None
    oracle_success: float | None = None
    judge_synthesis_regret: float | None = None
    cost_estimate: float | None = None
    latency_s: float | None = None
    tool_success: float | None = None
    candidate_failure_rate: float | None = None
    candidate_failures: dict[str, bool] = Field(default_factory=dict)
    model_ids: list[str] = Field(default_factory=list)
    judge_parse_failed: bool = False


class FusionBenchAggregateMetrics(BaseModel):
    total_tasks: int
    succeeded_tasks: int
    skipped_tasks: int
    failed_tasks: int
    unscored_tasks: int
    synthesized_success: float | None = None
    best_single_success: float | None = None
    random_success: float | None = None
    oracle_success: float | None = None
    judge_synthesis_regret: float | None = None
    cost_estimate: float | None = None
    latency_s: float | None = None
    tool_success: float | None = None
    candidate_failure_rate: float | None = None
    failure_kinds: dict[str, int] = Field(default_factory=dict)
    harness_verification_outcomes: dict[str, int] = Field(default_factory=dict)
    judge_parse_failures: int = 0


class FusionBenchFailureCorrelation(BaseModel):
    left_model_id: str
    right_model_id: str
    n: int
    left_failure_rate: float
    right_failure_rate: float
    correlation: float | None = None


class FusionBenchParetoPoint(BaseModel):
    id: str
    axis: ParetoAxis
    task_id: str
    config_id: str
    mode: str | None = None
    quality: float
    cost_estimate: float | None = None
    latency_s: float | None = None
    model_ids: list[str] = Field(default_factory=list)


class FusionBenchReproducibilityMetadata(BaseModel):
    schema_bundle_hashes: list[str] = Field(default_factory=list)
    repo_shas: list[str] = Field(default_factory=list)
    config_ids: list[str] = Field(default_factory=list)
    modes: list[str] = Field(default_factory=list)
    model_versions: dict[str, list[str]] = Field(default_factory=dict)
    task_ids: list[str] = Field(default_factory=list)
    task_source_shas: dict[str, str] = Field(default_factory=dict)
    prompt_hashes: dict[str, str] = Field(default_factory=dict)
    setup_hashes: dict[str, str] = Field(default_factory=dict)
    runtime_platform: str = Field(default_factory=platform.platform)
    python_version: str = Field(default_factory=platform.python_version)


class FusionBenchReport(BaseModel):
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    disclaimer: str = FUSION_BENCH_DISCLAIMER
    metadata: FusionBenchReproducibilityMetadata
    aggregate: FusionBenchAggregateMetrics
    tasks: list[FusionBenchTaskMetrics]
    failure_correlations: list[FusionBenchFailureCorrelation] = Field(default_factory=list)
    quality_cost_points: list[FusionBenchParetoPoint] = Field(default_factory=list)
    quality_latency_points: list[FusionBenchParetoPoint] = Field(default_factory=list)


class HandoffKitExecutorUnavailable(RuntimeError):
    pass


class HandoffKitExecutorError(RuntimeError):
    pass


class HandoffKitExecutor(Protocol):
    async def run(self, task: FusionBenchTask) -> list[dict[str, Any]]:
        raise NotImplementedError


class CommandHandoffKitExecutor:
    def __init__(
        self,
        command: Sequence[str] | str,
        *,
        timeout_s: float = 300.0,
        cwd: str | Path | None = None,
        env: Mapping[str, str | None] | None = None,
    ) -> None:
        self.command = shlex.split(command) if isinstance(command, str) else list(command)
        self.timeout_s = timeout_s
        self.cwd = Path(cwd) if cwd is not None else None
        self.env = dict(env) if env is not None else None
        if not self.command:
            raise ValueError("HandoffKit command must not be empty")

    def _subprocess_env(self) -> dict[str, str] | None:
        if self.env is None:
            return None
        merged = os.environ.copy()
        for key, value in self.env.items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[key] = value
        return merged

    async def run(self, task: FusionBenchTask) -> list[dict[str, Any]]:
        payload = {
            "category": task.category,
            "manifest_path": str(task.path),
            "task": task.record.model_dump(mode="json"),
        }
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command,
                cwd=str(self.cwd) if self.cwd is not None else None,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._subprocess_env(),
            )
        except FileNotFoundError as exc:
            raise HandoffKitExecutorUnavailable(str(exc)) from exc

        encoded_payload = json.dumps(payload).encode()
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(encoded_payload),
                timeout=self.timeout_s,
            )
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise HandoffKitExecutorError(
                f"HandoffKit command timed out after {self.timeout_s:.1f}s"
            ) from exc

        if process.returncode != 0:
            stderr_text = stderr.decode(errors="replace").strip()
            raise HandoffKitExecutorError(
                f"HandoffKit command exited with {process.returncode}: {stderr_text}"
            )
        return parse_handoffkit_records(stdout.decode())


class FusionBenchRunner:
    def __init__(
        self,
        engine: FusionEngine,
        *,
        run_root: str | Path,
        config_id: str,
        mode: FusionMode,
        model_versions: Mapping[str, str] | None = None,
        handoff_executor: HandoffKitExecutor | None = None,
    ) -> None:
        self.engine = engine
        self.run_root = Path(run_root)
        self.config_id = config_id
        self.mode: FusionMode = mode
        self.model_versions = dict(model_versions or {})
        self.handoff_executor = handoff_executor

    async def run_tasks(self, tasks: Iterable[FusionBenchTask]) -> list[FusionBenchAttemptRow]:
        rows = []
        for task in tasks:
            if task.record.task_kind == "model_fusion":
                rows.append(await self._run_model_fusion_task(task))
            elif task.record.task_kind == "harness_coding":
                rows.append(await self._run_harness_coding_task(task))
            else:
                rows.append(
                    skip_row(
                        task,
                        config_id=self.config_id,
                        mode=self.mode,
                        model_versions=self.model_versions,
                        failure=FusionBenchFailure(
                            failure_kind="unsupported_task_kind",
                            error_code="unsupported_task_kind",
                            owner="fusionkit",
                            terminal_reason="unsupported_task_kind",
                        ),
                    )
                )
        return rows

    async def _run_harness_coding_task(self, task: FusionBenchTask) -> FusionBenchAttemptRow:
        if self.handoff_executor is None:
            return skip_row(
                task,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
            )
        try:
            records = await self.handoff_executor.run(task)
        except HandoffKitExecutorUnavailable as exc:
            return skip_row(
                task,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
                failure=FusionBenchFailure(
                    failure_kind="unavailable_harness",
                    error_code="handoffkit_adapter_unavailable",
                    owner="handoffkit",
                    terminal_reason=str(exc) or "handoffkit_adapter_unavailable",
                ),
            )
        except (HandoffKitExecutorError, ValueError) as exc:
            return skip_row(
                task,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
                failure=FusionBenchFailure(
                    failure_kind="run_failed",
                    error_code="handoffkit_executor_failed",
                    owner="handoffkit",
                    terminal_reason=str(exc),
                ),
            )
        try:
            return join_handoffkit_records(
                task,
                records,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
            )
        except ValueError as exc:
            return skip_row(
                task,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
                failure=FusionBenchFailure(
                    failure_kind="validation_error",
                    error_code="handoffkit_contract_validation_failed",
                    owner="handoffkit",
                    terminal_reason=str(exc),
                ),
            )

    async def _run_model_fusion_task(self, task: FusionBenchTask) -> FusionBenchAttemptRow:
        store = FileSystemRunStore(self.run_root / task.record.task_id)
        manager = FusionRunManager(
            self.engine,
            store,
            LocalArtifactStore(self.run_root / task.record.task_id),
        )
        request = FusionRunRequestV1.model_validate(
            {
                **contract_metadata("fusion-run-request.v1"),
                "request_id": f"bench_{task.record.task_id}",
                "mode": self.mode,
                "messages": [{"role": "user", "content": task.record.prompt or ""}],
                "sampling": {},
                "verify": False,
            }
        )
        result = await manager.create_and_run(request)
        if not isinstance(result, RunInspection):
            return skip_row(
                task,
                config_id=self.config_id,
                mode=self.mode,
                model_versions=self.model_versions,
                failure=FusionBenchFailure(
                    failure_kind="run_failed",
                    error_code="run_not_inspectable",
                    owner="fusionkit",
                    terminal_reason="run_not_inspectable",
                ),
            )
        return join_run_records(
            task,
            store.list_events(result.run_id),
            result,
            config_id=self.config_id,
            mode=self.mode,
            model_versions=self.model_versions,
        )


def load_benchmark_tasks(root: str | Path = TINY_FIXTURE_ROOT) -> list[FusionBenchTask]:
    root_path = Path(root)
    if not root_path.exists():
        raise FileNotFoundError(f"Benchmark manifest path does not exist: {root_path}")
    tasks = []
    for path in sorted(root_path.glob("*/*.json")):
        task = BenchmarkTaskRecordV1.model_validate_json(path.read_text(encoding="utf-8"))
        tasks.append(FusionBenchTask(category=path.parent.name, path=path, record=task))
    for path in sorted(root_path.glob("*.json")):
        task = BenchmarkTaskRecordV1.model_validate_json(path.read_text(encoding="utf-8"))
        tasks.append(FusionBenchTask(category=root_path.name, path=path, record=task))
    return tasks


def join_run_records(
    task: FusionBenchTask,
    events: Iterable[Any],
    inspection: RunInspection,
    *,
    config_id: str,
    mode: FusionMode,
    model_versions: Mapping[str, str] | None = None,
) -> FusionBenchAttemptRow:
    event_list = list(events)
    fusion_record = _first_contract_payload(event_list, "fusion_record", FusionRecordV1)
    model_call_records = _contract_payloads(event_list, "model_call_record", ModelCallRecordV1)
    judge_synthesis_record = _first_contract_payload(
        event_list,
        "judge_synthesis_record",
        JudgeSynthesisRecordV1,
    )
    artifact_records = [
        payload
        for event in event_list
        if isinstance(payload := event.payload.get("artifact"), dict)
    ]
    tool_records = [
        payload
        for event in event_list
        for key in ("tool_call_plan", "tool_execution_record")
        if isinstance(payload := event.payload.get(key), dict)
    ]
    failure = _failure_from_inspection(inspection, judge_synthesis_record)
    return FusionBenchAttemptRow(
        task_id=task.record.task_id,
        category=task.category,
        task_kind=task.record.task_kind,
        manifest_path=str(task.path),
        manifest_hash=hash_text(task.path.read_text(encoding="utf-8")),
        schema_bundle_hash=schema_bundle_hash(),
        repo_sha=producer_git_sha(),
        config_id=config_id,
        mode=mode,
        model_versions=dict(model_versions or {}),
        run_id=inspection.run_id,
        trace_id=inspection.trace_id,
        state=inspection.state,
        status=inspection.status,
        output=inspection.final_output,
        failure=failure,
        task_record=task.record.model_dump(mode="json"),
        fusion_record=fusion_record,
        model_call_records=model_call_records,
        judge_synthesis_record=judge_synthesis_record,
        artifact_records=artifact_records,
        tool_records=tool_records,
        provider_metadata=inspection.provider_metadata,
        model_ids=[candidate.model_id for candidate in inspection.candidates],
        cost_estimate=_cost_from_provider_metadata(inspection.provider_metadata),
        latency_s=_latency_from_model_calls(model_call_records),
    )


def join_handoffkit_records(
    task: FusionBenchTask,
    records: Iterable[Mapping[str, Any]],
    *,
    config_id: str,
    mode: FusionMode,
    model_versions: Mapping[str, str] | None = None,
) -> FusionBenchAttemptRow:
    validated_records = [_validate_contract_payload(record) for record in records]
    benchmark_task_records = _records_by_schema(validated_records, "benchmark-task-record.v1")
    if benchmark_task_records:
        _assert_joined_task_matches(task, benchmark_task_records[0])

    harness_run_results = _records_by_schema(validated_records, "harness-run-result.v1")
    harness_candidates = _records_by_schema(validated_records, "harness-candidate-record.v1")
    model_call_records = _records_by_schema(validated_records, "model-call-record.v1")
    judge_synthesis_record = _first_record_by_schema(
        validated_records,
        "judge-synthesis-record.v1",
    )
    tool_records = [
        *(_records_by_schema(validated_records, "tool-call-plan.v1")),
        *(_records_by_schema(validated_records, "tool-execution-record.v1")),
    ]
    receipt_records = _records_by_schema(validated_records, "ensemble-receipt.v1")
    artifact_records = _artifact_records_from_contracts(validated_records)
    harness_run_result = harness_run_results[0] if harness_run_results else None
    failure = _failure_from_handoff_records(harness_run_result, judge_synthesis_record)
    status = harness_run_result.get("status") if harness_run_result is not None else "failed"
    return FusionBenchAttemptRow(
        task_id=task.record.task_id,
        category=task.category,
        task_kind=task.record.task_kind,
        manifest_path=str(task.path),
        manifest_hash=hash_text(task.path.read_text(encoding="utf-8")),
        schema_bundle_hash=schema_bundle_hash(),
        repo_sha=producer_git_sha(),
        config_id=config_id,
        mode=mode,
        model_versions=dict(model_versions or {}),
        run_id=_optional_string(harness_run_result, "result_id"),
        trace_id=_handoff_trace_id(harness_run_result),
        state=_state_for_handoff_status(status),
        status=status if isinstance(status, str) else "failed",
        output=_handoff_output(harness_run_result, judge_synthesis_record),
        failure=failure,
        task_record=task.record.model_dump(mode="json"),
        harness_run_result=harness_run_result,
        harness_candidate_records=harness_candidates,
        model_call_records=model_call_records,
        judge_synthesis_record=judge_synthesis_record,
        artifact_records=artifact_records,
        tool_records=tool_records,
        receipt_records=receipt_records,
        provider_metadata=_provider_metadata_from_model_calls(model_call_records),
        model_ids=_model_ids_from_handoff_records(model_call_records, harness_candidates),
        cost_estimate=_cost_from_provider_metadata(
            _provider_metadata_from_model_calls(model_call_records)
        ),
        latency_s=_latency_from_model_calls(model_call_records),
    )


def skip_row(
    task: FusionBenchTask,
    *,
    config_id: str,
    mode: FusionMode | None = None,
    model_versions: Mapping[str, str] | None = None,
    failure: FusionBenchFailure | None = None,
) -> FusionBenchAttemptRow:
    resolved_failure = failure or FusionBenchFailure(
        failure_kind="unavailable_harness",
        error_code="harness_unavailable",
        owner="handoffkit",
        retryable=False,
        terminal_reason="ensemble_adapter_not_configured",
    )
    return FusionBenchAttemptRow(
        task_id=task.record.task_id,
        category=task.category,
        task_kind=task.record.task_kind,
        manifest_path=str(task.path),
        manifest_hash=hash_text(task.path.read_text(encoding="utf-8")),
        schema_bundle_hash=schema_bundle_hash(),
        repo_sha=producer_git_sha(),
        config_id=config_id,
        mode=mode,
        model_versions=dict(model_versions or {}),
        failure=resolved_failure,
        task_record=task.record.model_dump(mode="json"),
    )


def write_fusion_bench_jsonl(path: str | Path, rows: Iterable[FusionBenchAttemptRow]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row.model_dump(mode="json")) + "\n")


def load_fusion_bench_jsonl(path: str | Path) -> list[FusionBenchAttemptRow]:
    with Path(path).open(encoding="utf-8") as handle:
        return [FusionBenchAttemptRow.model_validate_json(line) for line in handle if line.strip()]


def build_fusion_bench_report(rows: Iterable[FusionBenchAttemptRow]) -> FusionBenchReport:
    row_list = list(rows)
    task_metrics = [score_fusion_bench_row(row) for row in row_list]
    return FusionBenchReport(
        metadata=_reproducibility_metadata(row_list),
        aggregate=_aggregate_metrics(task_metrics),
        tasks=task_metrics,
        failure_correlations=_failure_correlations(task_metrics),
        quality_cost_points=_pareto_points(row_list, task_metrics, "quality_cost"),
        quality_latency_points=_pareto_points(row_list, task_metrics, "quality_latency"),
    )


def score_fusion_bench_row(row: FusionBenchAttemptRow) -> FusionBenchTaskMetrics:
    skipped = _row_is_skipped(row)
    failed = _row_is_failed(row)
    judge_parse_failed = _judge_parse_failed(row.judge_synthesis_record)
    candidate_scores = {} if skipped or failed else _candidate_scores(row)
    scored_candidates = list(candidate_scores.values())
    synthesized_success = None
    if not skipped and not failed:
        synthesized_success = _score_by_task_record(row.task_record, row.output)
    oracle_scores = [
        score for score in [synthesized_success, *scored_candidates] if score is not None
    ]
    candidate_failures = {
        model_id: score < 1.0
        for model_id, score in candidate_scores.items()
        if score is not None
    }
    return FusionBenchTaskMetrics(
        task_id=row.task_id,
        category=row.category,
        config_id=row.config_id,
        mode=row.mode,
        status=row.status,
        failure_kind=row.failure.failure_kind,
        skipped=skipped,
        failed=failed,
        harness_verification_outcome=_harness_verification_outcome(row, skipped, failed),
        synthesized_success=synthesized_success,
        best_single_success=max(scored_candidates, default=None),
        random_success=_average(scored_candidates),
        oracle_success=max(oracle_scores, default=None),
        judge_synthesis_regret=_regret(oracle_scores, synthesized_success),
        cost_estimate=row.cost_estimate,
        latency_s=row.latency_s,
        tool_success=_tool_success(row.tool_records),
        candidate_failure_rate=_candidate_failure_rate(scored_candidates),
        candidate_failures=candidate_failures,
        model_ids=list(row.model_ids),
        judge_parse_failed=judge_parse_failed,
    )


def write_fusion_bench_report_jsonl(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    report = _ensure_report(report_or_rows)
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        _write_report_record(handle, "metadata", report.metadata.model_dump(mode="json"))
        _write_report_record(handle, "aggregate", report.aggregate.model_dump(mode="json"))
        for task in report.tasks:
            _write_report_record(handle, "task_metrics", task.model_dump(mode="json"))
        for correlation in report.failure_correlations:
            _write_report_record(
                handle,
                "failure_correlation",
                correlation.model_dump(mode="json"),
            )
        for point in report.quality_cost_points:
            _write_report_record(handle, "pareto_quality_cost", point.model_dump(mode="json"))
        for point in report.quality_latency_points:
            _write_report_record(handle, "pareto_quality_latency", point.model_dump(mode="json"))


def write_fusion_bench_markdown_report(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        format_fusion_bench_markdown_report(report_or_rows),
        encoding="utf-8",
    )


def format_fusion_bench_markdown_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> str:
    report = _ensure_report(report_or_rows)
    lines = [
        "# Fusion Bench Report",
        "",
        f"Disclaimer: {report.disclaimer}.",
        "",
        "## Summary",
        "",
        f"- Tasks: {report.aggregate.total_tasks}",
        f"- Succeeded tasks: {report.aggregate.succeeded_tasks}",
        f"- Skipped tasks: {report.aggregate.skipped_tasks}",
        f"- Failed tasks: {report.aggregate.failed_tasks}",
        f"- Synthesized success: {_format_metric(report.aggregate.synthesized_success)}",
        f"- Best single success: {_format_metric(report.aggregate.best_single_success)}",
        f"- Random success: {_format_metric(report.aggregate.random_success)}",
        f"- Oracle success: {_format_metric(report.aggregate.oracle_success)}",
        f"- Judge-synthesis regret: {_format_metric(report.aggregate.judge_synthesis_regret)}",
        f"- Cost estimate: {_format_metric(report.aggregate.cost_estimate)}",
        f"- Latency: {_format_metric(report.aggregate.latency_s)}",
        f"- Tool success: {_format_metric(report.aggregate.tool_success)}",
        f"- Candidate failure rate: {_format_metric(report.aggregate.candidate_failure_rate)}",
        f"- Judge parse failures: {report.aggregate.judge_parse_failures}",
        "",
        "## Outcomes",
        "",
    ]
    for outcome, count in sorted(report.aggregate.harness_verification_outcomes.items()):
        lines.append(f"- {outcome}: {count}")
    lines.extend(
        [
            "",
            "## Failure Kinds",
            "",
        ]
    )
    for failure_kind, count in sorted(report.aggregate.failure_kinds.items()):
        lines.append(f"- {failure_kind}: {count}")
    lines.extend(
        [
            "",
            "## Task Metrics",
            "",
            "| Task | Category | Outcome | Synthesized | Best Single | Random | "
            "Oracle | Regret | Cost | Latency |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for task in report.tasks:
        lines.append(
            "| "
            f"{task.task_id} | "
            f"{task.category} | "
            f"{task.harness_verification_outcome} | "
            f"{_format_metric(task.synthesized_success)} | "
            f"{_format_metric(task.best_single_success)} | "
            f"{_format_metric(task.random_success)} | "
            f"{_format_metric(task.oracle_success)} | "
            f"{_format_metric(task.judge_synthesis_regret)} | "
            f"{_format_metric(task.cost_estimate)} | "
            f"{_format_metric(task.latency_s)} |"
        )
    lines.extend(["", "## Pairwise Failure Correlation", ""])
    if report.failure_correlations:
        lines.extend(
            [
                "| Left | Right | N | Left Failure | Right Failure | Correlation |",
                "| --- | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        for correlation in report.failure_correlations:
            lines.append(
                "| "
                f"{correlation.left_model_id} | "
                f"{correlation.right_model_id} | "
                f"{correlation.n} | "
                f"{_format_metric(correlation.left_failure_rate)} | "
                f"{_format_metric(correlation.right_failure_rate)} | "
                f"{_format_metric(correlation.correlation)} |"
            )
    else:
        lines.append("No overlapping scored candidate failures.")
    lines.extend(["", "## Pareto Plot Data", ""])
    lines.extend(_format_pareto_table("Quality vs Cost", report.quality_cost_points))
    lines.append("")
    lines.extend(_format_pareto_table("Quality vs Latency", report.quality_latency_points))
    lines.extend(
        [
            "",
            "## Reproducibility",
            "",
            f"- Schema bundle hashes: {', '.join(report.metadata.schema_bundle_hashes) or '-'}",
            f"- Repo SHAs: {', '.join(report.metadata.repo_shas) or '-'}",
            f"- Config IDs: {', '.join(report.metadata.config_ids) or '-'}",
            f"- Modes: {', '.join(report.metadata.modes) or '-'}",
            f"- Runtime platform: {report.metadata.runtime_platform}",
            f"- Python version: {report.metadata.python_version}",
            "",
        ]
    )
    return "\n".join(lines)


def write_fusion_bench_html_report(
    path: str | Path,
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        format_fusion_bench_html_report(report_or_rows),
        encoding="utf-8",
    )


def format_fusion_bench_html_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> str:
    markdown = format_fusion_bench_markdown_report(report_or_rows)
    body = "\n".join(f"<pre>{html.escape(markdown)}</pre>".splitlines())
    return (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        "<title>Fusion Bench Report</title>\n"
        "</head>\n"
        "<body>\n"
        f"{body}\n"
        "</body>\n"
        "</html>\n"
    )


def parse_handoffkit_records(output: str) -> list[dict[str, Any]]:
    stripped = output.strip()
    if not stripped:
        raise ValueError("HandoffKit executor produced no records")
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return [_coerce_record(json.loads(line)) for line in stripped.splitlines() if line.strip()]
    if isinstance(parsed, list):
        return [_coerce_record(record) for record in parsed]
    if isinstance(parsed, dict):
        if isinstance(records := parsed.get("records"), list):
            return [_coerce_record(record) for record in records]
        if isinstance(parsed.get("schema"), str):
            return [_coerce_record(parsed)]
    raise ValueError("HandoffKit executor output must be a record, record list, or records object")


def _coerce_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError("HandoffKit executor records must be JSON objects")
    return record


def _validate_contract_payload(record: Mapping[str, Any]) -> dict[str, Any]:
    schema = record.get("schema")
    if not isinstance(schema, str):
        raise ValueError("Contract record is missing string schema")
    try:
        model_class = contract_model_for_schema(schema)  # type: ignore[arg-type]
    except KeyError as exc:
        raise ValueError(f"Unsupported contract schema from handoff executor: {schema}") from exc
    return model_class.model_validate(record).model_dump(mode="json")


def _records_by_schema(records: list[dict[str, Any]], schema: str) -> list[dict[str, Any]]:
    return [record for record in records if record.get("schema") == schema]


def _first_record_by_schema(
    records: list[dict[str, Any]],
    schema: str,
) -> dict[str, Any] | None:
    matching = _records_by_schema(records, schema)
    return matching[0] if matching else None


def _assert_joined_task_matches(
    task: FusionBenchTask,
    joined_task_record: Mapping[str, Any],
) -> None:
    joined_task_id = joined_task_record.get("task_id")
    if joined_task_id != task.record.task_id:
        raise ValueError(
            f"HandoffKit benchmark task record {joined_task_id!r} does not match "
            f"manifest task {task.record.task_id!r}"
        )


def _artifact_records_from_contracts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    artifacts = []
    for record in records:
        if record.get("schema") == "artifact-ref.v1":
            artifacts.append(ArtifactRefV1.model_validate(record).model_dump(mode="json"))
        for artifact in record.get("artifacts") or []:
            if isinstance(artifact, dict):
                artifacts.append(ContractArtifactRef.model_validate(artifact).model_dump(mode="json"))
    return artifacts


def _contract_payloads(events: list[Any], key: str, model_class: type) -> list[dict[str, Any]]:
    payloads = []
    for event in events:
        payload = event.payload.get(key)
        if isinstance(payload, dict):
            payloads.append(model_class.model_validate(payload).model_dump(mode="json"))
    return payloads


def _first_contract_payload(
    events: list[Any],
    key: str,
    model_class: type,
) -> dict[str, Any] | None:
    payloads = _contract_payloads(events, key, model_class)
    return payloads[0] if payloads else None


def _failure_from_inspection(
    inspection: RunInspection,
    judge_synthesis_record: Mapping[str, Any] | None,
) -> FusionBenchFailure:
    if _judge_parse_failed(judge_synthesis_record):
        return FusionBenchFailure(
            failure_kind="validation_error",
            error_code="judge_structured_json_parse_failed",
            owner="fusionkit",
            retryable=False,
            terminal_reason="judge_structured_json_parse_failed",
        )
    if inspection.terminal_error is None:
        return FusionBenchFailure()
    return FusionBenchFailure(
        failure_kind="run_failed",
        error_code=inspection.terminal_error.error_code,
        owner=inspection.terminal_error.owner,
        retryable=inspection.terminal_error.retryable,
        terminal_reason=inspection.terminal_error.terminal_reason,
    )


def _failure_from_handoff_records(
    harness_run_result: Mapping[str, Any] | None,
    judge_synthesis_record: Mapping[str, Any] | None,
) -> FusionBenchFailure:
    if harness_run_result is None:
        return FusionBenchFailure(
            failure_kind="validation_error",
            error_code="missing_harness_run_result",
            owner="handoffkit",
            terminal_reason="missing_harness_run_result",
        )
    if _judge_parse_failed(judge_synthesis_record):
        return FusionBenchFailure(
            failure_kind="validation_error",
            error_code="judge_structured_json_parse_failed",
            owner="handoffkit",
            terminal_reason="judge_structured_json_parse_failed",
        )
    status = harness_run_result.get("status")
    if status == "succeeded":
        return FusionBenchFailure()
    error = _first_contract_error(harness_run_result.get("errors"))
    if status in {"skipped", "unsupported"}:
        return FusionBenchFailure(
            failure_kind="unavailable_harness",
            error_code=_error_code(error, status),
            owner="handoffkit",
            retryable=_error_retryable(error),
            terminal_reason=_error_message(error, status),
        )
    return FusionBenchFailure(
        failure_kind="run_failed",
        error_code=_error_code(error, "harness_run_failed"),
        owner="handoffkit",
        retryable=_error_retryable(error),
        terminal_reason=_error_message(error, "harness_run_failed"),
    )


def _first_contract_error(errors: Any) -> dict[str, Any] | None:
    if not isinstance(errors, list):
        return None
    for error in errors:
        if isinstance(error, dict):
            return ContractError.model_validate(error).model_dump(mode="json")
    return None


def _error_code(error: Mapping[str, Any] | None, default: str) -> str:
    if error is None:
        return default
    kind = error.get("kind")
    return kind if isinstance(kind, str) else default


def _error_message(error: Mapping[str, Any] | None, default: str) -> str:
    if error is None:
        return default
    message = error.get("message")
    return message if isinstance(message, str) else default


def _error_retryable(error: Mapping[str, Any] | None) -> bool:
    if error is None:
        return False
    return error.get("retryable") is True


def _judge_parse_failed(judge_synthesis_record: Mapping[str, Any] | None) -> bool:
    if judge_synthesis_record is None:
        return False
    metrics = judge_synthesis_record.get("metrics")
    return isinstance(metrics, Mapping) and metrics.get("judge_structured_parse_status") == "failed"


def _cost_from_provider_metadata(provider_metadata: list[dict[str, Any]]) -> float | None:
    costs = [
        float(cost)
        for metadata in provider_metadata
        if isinstance(cost := metadata.get("cost_estimate"), int | float)
    ]
    if not costs:
        return None
    return sum(costs)


def _latency_from_model_calls(model_call_records: list[dict[str, Any]]) -> float | None:
    latencies = [
        float(latency) / 1000
        for record in model_call_records
        if isinstance(latency := record.get("latency_ms"), int | float)
    ]
    if not latencies:
        return None
    return sum(latencies)


def _provider_metadata_from_model_calls(
    model_call_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    provider_metadata = []
    for record in model_call_records:
        metadata = record.get("metadata")
        if isinstance(metadata, dict):
            provider_metadata.append(metadata)
    return provider_metadata


def _model_ids_from_handoff_records(
    model_call_records: list[dict[str, Any]],
    harness_candidate_records: list[dict[str, Any]],
) -> list[str]:
    model_ids = []
    seen = set()
    for record in model_call_records:
        for key in ("endpoint_id", "model"):
            value = record.get(key)
            if isinstance(value, str) and value and value not in seen:
                seen.add(value)
                model_ids.append(value)
                break
    for record in harness_candidate_records:
        metadata = record.get("metadata")
        model_id = metadata.get("model_id") if isinstance(metadata, dict) else None
        fallback = record.get("model_call_id") or record.get("candidate_id")
        value = model_id if isinstance(model_id, str) else fallback
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            model_ids.append(value)
    return model_ids


def _handoff_trace_id(harness_run_result: Mapping[str, Any] | None) -> str | None:
    metadata = harness_run_result.get("metadata") if harness_run_result is not None else None
    if not isinstance(metadata, Mapping):
        return None
    trace_id = metadata.get("trace_id")
    return trace_id if isinstance(trace_id, str) else None


def _handoff_output(
    harness_run_result: Mapping[str, Any] | None,
    judge_synthesis_record: Mapping[str, Any] | None,
) -> str | None:
    if judge_synthesis_record is not None:
        final_output = judge_synthesis_record.get("final_output")
        if isinstance(final_output, str):
            return final_output
    if harness_run_result is None:
        return None
    output_summary = harness_run_result.get("output_summary")
    return output_summary if isinstance(output_summary, str) else None


def _optional_string(record: Mapping[str, Any] | None, key: str) -> str | None:
    if record is None:
        return None
    value = record.get(key)
    return value if isinstance(value, str) else None


def _state_for_handoff_status(status: Any) -> str | None:
    if status == "succeeded":
        return "completed"
    if status == "failed":
        return "failed"
    if status == "canceled":
        return "cancelled"
    if status == "pending":
        return "queued"
    if status == "running":
        return "generating"
    if status in {"skipped", "unsupported"}:
        return "completed"
    return None


def _ensure_report(
    report_or_rows: FusionBenchReport | Iterable[FusionBenchAttemptRow],
) -> FusionBenchReport:
    if isinstance(report_or_rows, FusionBenchReport):
        return report_or_rows
    return build_fusion_bench_report(report_or_rows)


def _write_report_record(handle: Any, record_type: str, payload: dict[str, Any]) -> None:
    handle.write(json.dumps({"record_type": record_type, **payload}) + "\n")


def _row_is_skipped(row: FusionBenchAttemptRow) -> bool:
    return (
        row.status in {"skipped", "unsupported"}
        or row.failure.failure_kind in SKIPPED_FAILURE_KINDS
    )


def _row_is_failed(row: FusionBenchAttemptRow) -> bool:
    if _row_is_skipped(row):
        return False
    if _judge_parse_failed(row.judge_synthesis_record):
        return True
    return row.status == "failed" or row.failure.failure_kind not in {
        "none",
        *SKIPPED_FAILURE_KINDS,
    }


def _harness_verification_outcome(
    row: FusionBenchAttemptRow,
    skipped: bool,
    failed: bool,
) -> HarnessVerificationOutcome:
    if skipped:
        return "skipped"
    if failed:
        return "failed"
    if row.status == "succeeded" or (row.failure.failure_kind == "none" and row.run_id is not None):
        return "succeeded"
    return "unknown"


def _score_by_task_record(task_record: Mapping[str, Any], output: str | None) -> float | None:
    if output is None:
        return None
    scorer = task_record.get("scorer")
    if not isinstance(scorer, Mapping):
        return None
    kind = scorer.get("kind")
    params = scorer.get("params")
    if not isinstance(params, Mapping):
        params = {}
    if kind == "exact":
        return exact_match(output, _expected(params))
    if kind == "contains":
        return contains_expected(output, _expected(params))
    if kind == "custom":
        if "json_keys" in params:
            return _json_key_score(output, params["json_keys"])
        if params.get("tool_call_validity") is True:
            return _tool_call_validity(output, params)
    return None


def _candidate_scores(row: FusionBenchAttemptRow) -> dict[str, float]:
    judge_call_id = None
    if row.judge_synthesis_record is not None:
        judge_call_id = row.judge_synthesis_record.get("judge_model_call_id")
    scores: dict[str, list[float]] = {}
    for record in row.model_call_records:
        call_id = record.get("call_id")
        if call_id == judge_call_id:
            continue
        output = record.get("output_text")
        score = _score_by_task_record(row.task_record, output if isinstance(output, str) else None)
        if score is None:
            continue
        model_id = _candidate_model_id(record)
        scores.setdefault(model_id, []).append(score)
    return {model_id: sum(values) / len(values) for model_id, values in scores.items()}


def _candidate_model_id(record: Mapping[str, Any]) -> str:
    for key in ("endpoint_id", "model", "call_id"):
        value = record.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown"


def _expected(params: Mapping[str, Any]) -> str | None:
    expected = params.get("expected")
    return expected if isinstance(expected, str) else None


def _json_key_score(output: str, keys: Any) -> float:
    if not isinstance(keys, list):
        return 0.0
    try:
        data = json.loads(output)
    except json.JSONDecodeError:
        return 0.0
    if not isinstance(data, dict):
        return 0.0
    return float(all(isinstance(key, str) and key in data for key in keys))


def _tool_call_validity(output: str, params: Mapping[str, Any]) -> float | None:
    expected_tool = params.get("expected_tool")
    if isinstance(expected_tool, str):
        return float(expected_tool.lower() in output.lower())
    if params.get("tool_expected") is False:
        return float("tool" not in output.lower() or "no tool" in output.lower())
    return None


def _regret(oracle_scores: list[float], synthesized_success: float | None) -> float | None:
    if synthesized_success is None or not oracle_scores:
        return None
    return max(oracle_scores) - synthesized_success


def _tool_success(tool_records: list[dict[str, Any]]) -> float | None:
    execution_records = [
        record
        for record in tool_records
        if record.get("schema") == "tool-execution-record.v1" or "execution_id" in record
    ]
    if not execution_records:
        return None
    succeeded = sum(1 for record in execution_records if record.get("status") == "succeeded")
    return succeeded / len(execution_records)


def _candidate_failure_rate(scores: list[float]) -> float | None:
    if not scores:
        return None
    return sum(1 for score in scores if score < 1.0) / len(scores)


def _aggregate_metrics(tasks: list[FusionBenchTaskMetrics]) -> FusionBenchAggregateMetrics:
    scored_tasks = [task for task in tasks if task.synthesized_success is not None]
    return FusionBenchAggregateMetrics(
        total_tasks=len(tasks),
        succeeded_tasks=sum(
            1 for task in tasks if task.harness_verification_outcome == "succeeded"
        ),
        skipped_tasks=sum(1 for task in tasks if task.skipped),
        failed_tasks=sum(1 for task in tasks if task.failed),
        unscored_tasks=len(tasks) - len(scored_tasks),
        synthesized_success=_average_metric(tasks, "synthesized_success"),
        best_single_success=_average_metric(tasks, "best_single_success"),
        random_success=_average_metric(tasks, "random_success"),
        oracle_success=_average_metric(tasks, "oracle_success"),
        judge_synthesis_regret=_average_metric(tasks, "judge_synthesis_regret"),
        cost_estimate=_average_metric(tasks, "cost_estimate"),
        latency_s=_average_metric(tasks, "latency_s"),
        tool_success=_average_metric(tasks, "tool_success"),
        candidate_failure_rate=_average_metric(tasks, "candidate_failure_rate"),
        failure_kinds=dict(Counter(task.failure_kind for task in tasks)),
        harness_verification_outcomes=dict(
            Counter(task.harness_verification_outcome for task in tasks)
        ),
        judge_parse_failures=sum(1 for task in tasks if task.judge_parse_failed),
    )


def _average_metric(tasks: list[FusionBenchTaskMetrics], field: str) -> float | None:
    return _average(
        [
            value
            for task in tasks
            if isinstance(value := getattr(task, field), int | float)
        ]
    )


def _average(values: Iterable[float]) -> float | None:
    value_list = list(values)
    if not value_list:
        return None
    return sum(value_list) / len(value_list)


def _failure_correlations(
    tasks: list[FusionBenchTaskMetrics],
) -> list[FusionBenchFailureCorrelation]:
    model_ids = sorted({model_id for task in tasks for model_id in task.candidate_failures})
    correlations = []
    for left_index, left_model_id in enumerate(model_ids):
        for right_model_id in model_ids[left_index + 1 :]:
            paired = [
                (
                    float(task.candidate_failures[left_model_id]),
                    float(task.candidate_failures[right_model_id]),
                )
                for task in tasks
                if left_model_id in task.candidate_failures
                and right_model_id in task.candidate_failures
            ]
            if not paired:
                continue
            left_values = [left for left, _right in paired]
            right_values = [right for _left, right in paired]
            correlations.append(
                FusionBenchFailureCorrelation(
                    left_model_id=left_model_id,
                    right_model_id=right_model_id,
                    n=len(paired),
                    left_failure_rate=sum(left_values) / len(left_values),
                    right_failure_rate=sum(right_values) / len(right_values),
                    correlation=_pearson(left_values, right_values),
                )
            )
    return correlations


def _pearson(left_values: list[float], right_values: list[float]) -> float | None:
    if len(left_values) < 2 or len(right_values) < 2:
        return None
    left_mean = sum(left_values) / len(left_values)
    right_mean = sum(right_values) / len(right_values)
    numerator = sum(
        (left - left_mean) * (right - right_mean)
        for left, right in zip(left_values, right_values, strict=True)
    )
    left_denominator = math.sqrt(sum((left - left_mean) ** 2 for left in left_values))
    right_denominator = math.sqrt(sum((right - right_mean) ** 2 for right in right_values))
    if left_denominator == 0 or right_denominator == 0:
        return None
    return numerator / (left_denominator * right_denominator)


def _pareto_points(
    rows: list[FusionBenchAttemptRow],
    tasks: list[FusionBenchTaskMetrics],
    axis: ParetoAxis,
) -> list[FusionBenchParetoPoint]:
    points = []
    for row, task in zip(rows, tasks, strict=True):
        if task.synthesized_success is None:
            continue
        if axis == "quality_cost":
            if task.cost_estimate is None:
                continue
            points.append(
                FusionBenchParetoPoint(
                    id=f"{task.task_id}:{task.config_id}:cost",
                    axis=axis,
                    task_id=task.task_id,
                    config_id=task.config_id,
                    mode=task.mode,
                    quality=task.synthesized_success,
                    cost_estimate=task.cost_estimate,
                    model_ids=list(row.model_ids),
                )
            )
        elif axis == "quality_latency":
            if task.latency_s is None:
                continue
            points.append(
                FusionBenchParetoPoint(
                    id=f"{task.task_id}:{task.config_id}:latency",
                    axis=axis,
                    task_id=task.task_id,
                    config_id=task.config_id,
                    mode=task.mode,
                    quality=task.synthesized_success,
                    latency_s=task.latency_s,
                    model_ids=list(row.model_ids),
                )
            )
        else:
            raise AssertionError(f"Unhandled pareto axis: {axis}")
    return points


def _reproducibility_metadata(
    rows: list[FusionBenchAttemptRow],
) -> FusionBenchReproducibilityMetadata:
    model_versions: dict[str, set[str]] = {}
    task_source_shas = {}
    prompt_hashes = {}
    setup_hashes = {}
    for row in rows:
        for endpoint_id, version in row.model_versions.items():
            model_versions.setdefault(endpoint_id, set()).add(version)
        source_sha = row.task_record.get("source_sha")
        prompt_hash = row.task_record.get("prompt_hash")
        setup_hash = row.task_record.get("setup_hash")
        if isinstance(source_sha, str):
            task_source_shas[row.task_id] = source_sha
        if isinstance(prompt_hash, str):
            prompt_hashes[row.task_id] = prompt_hash
        if isinstance(setup_hash, str):
            setup_hashes[row.task_id] = setup_hash
    return FusionBenchReproducibilityMetadata(
        schema_bundle_hashes=sorted({row.schema_bundle_hash for row in rows}),
        repo_shas=sorted({row.repo_sha for row in rows}),
        config_ids=sorted({row.config_id for row in rows}),
        modes=sorted({row.mode for row in rows if row.mode is not None}),
        model_versions={
            endpoint_id: sorted(versions)
            for endpoint_id, versions in sorted(model_versions.items())
        },
        task_ids=sorted({row.task_id for row in rows}),
        task_source_shas=task_source_shas,
        prompt_hashes=prompt_hashes,
        setup_hashes=setup_hashes,
    )


def _format_pareto_table(title: str, points: list[FusionBenchParetoPoint]) -> list[str]:
    lines = [
        f"### {title}",
        "",
    ]
    if not points:
        lines.append("No scored points with this axis available.")
        return lines
    lines.extend(
        [
            "| ID | Quality | Cost | Latency |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    for point in points:
        lines.append(
            "| "
            f"{point.id} | "
            f"{_format_metric(point.quality)} | "
            f"{_format_metric(point.cost_estimate)} | "
            f"{_format_metric(point.latency_s)} |"
        )
    return lines


def _format_metric(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.4f}"


__all__ = [
    "CommandHandoffKitExecutor",
    "FUSION_BENCH_DISCLAIMER",
    "FusionBenchAggregateMetrics",
    "FusionBenchAttemptRow",
    "FusionBenchFailure",
    "FusionBenchFailureCorrelation",
    "FusionBenchParetoPoint",
    "FusionBenchReport",
    "FusionBenchReproducibilityMetadata",
    "FusionBenchRunner",
    "FusionBenchTask",
    "FusionBenchTaskMetrics",
    "HandoffKitExecutor",
    "HandoffKitExecutorError",
    "HandoffKitExecutorUnavailable",
    "build_fusion_bench_report",
    "format_fusion_bench_html_report",
    "format_fusion_bench_markdown_report",
    "join_run_records",
    "join_handoffkit_records",
    "load_benchmark_tasks",
    "load_fusion_bench_jsonl",
    "parse_handoffkit_records",
    "score_fusion_bench_row",
    "skip_row",
    "write_fusion_bench_jsonl",
    "write_fusion_bench_html_report",
    "write_fusion_bench_markdown_report",
    "write_fusion_bench_report_jsonl",
]
