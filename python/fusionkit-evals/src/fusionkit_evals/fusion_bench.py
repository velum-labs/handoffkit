from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Literal

from fusionkit_core.artifacts import LocalArtifactStore, hash_text
from fusionkit_core.config import FusionMode
from fusionkit_core.contracts import (
    BenchmarkTaskRecordV1,
    FusionRecordV1,
    FusionRunRequestV1,
    JudgeSynthesisRecordV1,
    ModelCallRecordV1,
    contract_metadata,
    producer_git_sha,
    schema_bundle_hash,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import FusionRunManager, RunInspection
from fusionkit_core.run_store import FileSystemRunStore
from pydantic import BaseModel, Field

from fusionkit_evals.tiny import TINY_FIXTURE_ROOT

FailureKind = Literal[
    "none",
    "unavailable_provider",
    "unavailable_harness",
    "run_failed",
    "validation_error",
    "unsupported_task_kind",
]


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


class FusionBenchRunner:
    def __init__(
        self,
        engine: FusionEngine,
        *,
        run_root: str | Path,
        config_id: str,
        mode: FusionMode,
        model_versions: Mapping[str, str] | None = None,
    ) -> None:
        self.engine = engine
        self.run_root = Path(run_root)
        self.config_id = config_id
        self.mode: FusionMode = mode
        self.model_versions = dict(model_versions or {})

    async def run_tasks(self, tasks: Iterable[FusionBenchTask]) -> list[FusionBenchAttemptRow]:
        rows = []
        for task in tasks:
            if task.record.task_kind == "model_fusion":
                rows.append(await self._run_model_fusion_task(task))
            elif task.record.task_kind == "harness_coding":
                rows.append(
                    skip_row(
                        task,
                        config_id=self.config_id,
                        mode=self.mode,
                        model_versions=self.model_versions,
                    )
                )
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
    failure = _failure_from_inspection(inspection)
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


def _failure_from_inspection(inspection: RunInspection) -> FusionBenchFailure:
    if inspection.terminal_error is None:
        return FusionBenchFailure()
    return FusionBenchFailure(
        failure_kind="run_failed",
        error_code=inspection.terminal_error.error_code,
        owner=inspection.terminal_error.owner,
        retryable=inspection.terminal_error.retryable,
        terminal_reason=inspection.terminal_error.terminal_reason,
    )


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


__all__ = [
    "FusionBenchAttemptRow",
    "FusionBenchFailure",
    "FusionBenchRunner",
    "FusionBenchTask",
    "join_run_records",
    "load_benchmark_tasks",
    "load_fusion_bench_jsonl",
    "skip_row",
    "write_fusion_bench_jsonl",
]
