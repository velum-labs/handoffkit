from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import Any

from fusionkit_core.artifacts import hash_text
from fusionkit_core.contracts import ContractArtifactRef
from fusionkit_core.run import (
    FusionRunEvent,
    IdempotencyRecord,
    NativeRunError,
    RunEventPage,
    RunInspection,
    RunStateSummary,
    ToolPausePlaceholder,
    TrajectoryInspection,
)


class FileSystemRunStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "_idempotency").mkdir(parents=True, exist_ok=True)

    def get_idempotency(self, idempotency_key: str) -> IdempotencyRecord | None:
        path = self._idempotency_path(idempotency_key)
        if not path.exists():
            return None
        return IdempotencyRecord.model_validate(_read_json(path))

    def write_idempotency(self, record: IdempotencyRecord) -> None:
        path = self._idempotency_path(record.idempotency_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(path, record.model_dump(mode="json"))

    def append_event(self, event: FusionRunEvent) -> FusionRunEvent:
        run_dir = self._run_dir(event.run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        event_path = self._event_path(event.run_id)
        seq_path = self._seq_path(event.run_id)
        # Serialize the read-max-then-append across coroutines, threadpool
        # workers, and separate processes. flock is associated with the open
        # file description, so two independent open() calls contend even within
        # one process. The next sequence number is tracked in an O(1) counter
        # file so appends do not re-parse the whole event log (was O(n^2)).
        with self._lock_path(event.run_id).open("a", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle, fcntl.LOCK_EX)
            try:
                last_seq = self._read_seq(seq_path)
                if last_seq is None:
                    # Migrate a run created before the counter file existed.
                    last_seq = self._next_event_seq(event.run_id) - 1
                event_seq = last_seq + 1
                sequenced_event = event.model_copy(update={"event_seq": event_seq})
                with event_path.open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(sequenced_event.model_dump(mode="json")) + "\n"
                    )
                self._write_seq(seq_path, event_seq)
            finally:
                fcntl.flock(lock_handle, fcntl.LOCK_UN)
        return sequenced_event

    def list_events(self, run_id: str, after: int | None = None) -> list[FusionRunEvent]:
        event_path = self._event_path(run_id)
        if not event_path.exists():
            return []
        events = []
        with event_path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    event = FusionRunEvent.model_validate_json(line)
                    if after is None or event.event_seq > after:
                        events.append(event)
        return events

    def event_page(self, run_id: str, after: int | None = None) -> RunEventPage:
        events = self.list_events(run_id, after=after)
        next_cursor = events[-1].event_seq if events else after
        return RunEventPage(run_id=run_id, events=events, next_event_cursor=next_cursor)

    def read_summary(self, run_id: str) -> RunStateSummary:
        summary_path = self._summary_path(run_id)
        if summary_path.exists():
            return RunStateSummary.model_validate(_read_json(summary_path))
        summary = self._summary_from_events(run_id)
        self.write_summary(summary)
        return summary

    def write_summary(self, summary: RunStateSummary) -> None:
        run_dir = self._run_dir(summary.run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        _write_json(self._summary_path(summary.run_id), summary.model_dump(mode="json"))

    def inspect_run(self, run_id: str) -> RunInspection:
        events = self.list_events(run_id)
        summary = self.read_summary(run_id)
        trajectories: list[TrajectoryInspection] = []
        artifacts: list[ContractArtifactRef] = []
        model_call_ids = []
        final_output = summary.final_output
        final_output_artifact = None
        judge_synthesis_record = None
        pending_tool_actions: dict[str, ToolPausePlaceholder] = {}
        provider_metadata = []

        for event in events:
            if event.event_type == "trajectory_recorded":
                trajectory_payload = event.payload.get("trajectory")
                if isinstance(trajectory_payload, dict):
                    artifact = _artifact_from_payload(trajectory_payload.get("artifact"))
                    if artifact is not None:
                        artifacts.append(artifact)
                    trajectories.append(
                        TrajectoryInspection(
                            trajectory_id=str(trajectory_payload["trajectory_id"]),
                            model_id=str(trajectory_payload["model_id"]),
                            source_trajectory_id=_optional_str(
                                trajectory_payload.get("source_trajectory_id")
                            ),
                            model_call_id=event.model_call_id,
                            artifact=artifact,
                            score=trajectory_payload.get("score"),
                            rank=trajectory_payload.get("rank"),
                        )
                    )
            elif event.event_type == "model_call_recorded":
                if event.model_call_id is not None:
                    model_call_ids.append(event.model_call_id)
                model_call_payload = event.payload.get("model_call_record")
                if isinstance(model_call_payload, dict) and isinstance(
                    model_call_payload.get("metadata"), dict
                ):
                    provider_metadata.append(model_call_payload["metadata"])
            elif event.event_type == "artifact_recorded":
                artifact = _artifact_from_payload(event.payload.get("artifact"))
                if artifact is not None:
                    artifacts.append(artifact)
            elif event.event_type == "fusion_recorded":
                fusion_record = event.payload.get("fusion_record")
                if isinstance(fusion_record, dict):
                    final_output = str(fusion_record.get("final_output") or final_output or "")
                    for artifact_payload in fusion_record.get("artifacts", []):
                        artifact = _artifact_from_payload(artifact_payload)
                        if artifact is None:
                            continue
                        artifacts.append(artifact)
                        if artifact.kind in ("transcript", "metrics"):
                            final_output_artifact = artifact
            elif event.event_type == "judge_synthesis_recorded":
                judge_synthesis_record = event.payload.get("judge_synthesis_record")
            elif event.event_type == "requires_action":
                requires_action_payload = event.payload.get("requires_action")
                if isinstance(requires_action_payload, dict):
                    pause = ToolPausePlaceholder.model_validate(
                        requires_action_payload
                    )
                    pending_tool_actions[pause.tool_call_id] = pause
            elif event.event_type == "tool_execution_recorded" and event.tool_call_id is not None:
                pending_tool_actions.pop(event.tool_call_id, None)

        return RunInspection(
            run_id=run_id,
            trace_id=summary.trace_id,
            state=summary.state,
            status=summary.status,
            event_cursor=summary.event_cursor,
            trajectories=trajectories,
            artifacts=_dedupe_artifacts(artifacts),
            model_call_ids=model_call_ids,
            final_output=final_output,
            final_output_artifact=final_output_artifact,
            judge_synthesis_record=judge_synthesis_record,
            requires_action=_latest_pending_action(pending_tool_actions),
            terminal_error=summary.terminal_error,
            provider_metadata=provider_metadata,
        )

    def _summary_from_events(self, run_id: str) -> RunStateSummary:
        events = self.list_events(run_id)
        if not events:
            raise FileNotFoundError(f"Unknown run: {run_id}")
        first = events[0]
        last = events[-1]
        terminal_error = None
        terminal_reason = None
        final_output = None
        for event in events:
            if event.event_type == "error_recorded":
                error_payload = event.payload.get("error")
                if isinstance(error_payload, dict):
                    terminal_error = NativeRunError.model_validate(error_payload)
                    terminal_reason = terminal_error.terminal_reason
            elif event.event_type == "fusion_recorded":
                fusion_record = event.payload.get("fusion_record")
                if isinstance(fusion_record, dict):
                    final_output = fusion_record.get("final_output")
        return RunStateSummary(
            run_id=run_id,
            trace_id=first.trace_id,
            state=last.state,
            status=last.status,
            event_cursor=last.event_seq,
            idempotency_key=first.idempotency_key,
            request_hash=first.request_hash,
            terminal_error=terminal_error,
            terminal_reason=terminal_reason,
            final_output=final_output,
        )

    def _next_event_seq(self, run_id: str) -> int:
        events = self.list_events(run_id)
        return events[-1].event_seq + 1 if events else 1

    def _read_seq(self, seq_path: Path) -> int | None:
        try:
            return int(seq_path.read_text(encoding="utf-8").strip())
        except (FileNotFoundError, ValueError):
            return None

    def _write_seq(self, seq_path: Path, value: int) -> None:
        seq_path.write_text(str(value), encoding="utf-8")

    def _run_dir(self, run_id: str) -> Path:
        return self.root / run_id

    def _event_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "events.jsonl"

    def _seq_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "events.seq"

    def _lock_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "events.lock"

    def _summary_path(self, run_id: str) -> Path:
        return self._run_dir(run_id) / "summary.json"

    def _idempotency_path(self, idempotency_key: str) -> Path:
        return self.root / "_idempotency" / f"{hash_text(idempotency_key)}.json"


def _read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, sort_keys=True)


def _artifact_from_payload(payload: Any) -> ContractArtifactRef | None:
    if not isinstance(payload, dict):
        return None
    return ContractArtifactRef.model_validate(payload)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _latest_pending_action(
    pending_tool_actions: dict[str, ToolPausePlaceholder],
) -> ToolPausePlaceholder | None:
    if not pending_tool_actions:
        return None
    return list(pending_tool_actions.values())[-1]


def _dedupe_artifacts(artifacts: list[ContractArtifactRef]) -> list[ContractArtifactRef]:
    deduped = {}
    for artifact in artifacts:
        deduped[artifact.artifact_id] = artifact
    return list(deduped.values())


__all__ = [
    "FileSystemRunStore",
]
