from __future__ import annotations

from fusionkit_core.contracts import status_for_run_state
from fusionkit_core.run import FusionRunEvent, IdempotencyRecord, NativeRunError, make_id
from fusionkit_core.run_store import FileSystemRunStore


def test_run_store_appends_events_and_replays_after_cursor(tmp_path) -> None:
    store = FileSystemRunStore(tmp_path / "runs")
    run_id = "run_test_001"
    trace_id = make_id("trace")

    first = store.append_event(
        FusionRunEvent(
            event_seq=1,
            run_id=run_id,
            trace_id=trace_id,
            state="queued",
            status=status_for_run_state("queued"),
            event_type="run_queued",
        )
    )
    second = store.append_event(
        FusionRunEvent(
            event_seq=1,
            run_id=run_id,
            trace_id=trace_id,
            state="generating",
            status=status_for_run_state("generating"),
            event_type="state_changed",
        )
    )

    assert first.event_seq == 1
    assert second.event_seq == 2
    page = store.event_page(run_id, after=1)
    assert [event.event_seq for event in page.events] == [2]
    assert page.next_event_cursor == 2


def test_run_store_reconstructs_summary_from_terminal_error(tmp_path) -> None:
    store = FileSystemRunStore(tmp_path / "runs")
    run_id = "run_test_failed"
    trace_id = make_id("trace")
    error = NativeRunError(
        error_kind="internal_error",
        error_code="SyntheticFailure",
        retryable=False,
        owner="fusionkit",
        terminal_reason="run_execution_failed",
    )

    store.append_event(
        FusionRunEvent(
            event_seq=1,
            run_id=run_id,
            trace_id=trace_id,
            state="queued",
            status="pending",
            event_type="run_queued",
        )
    )
    store.append_event(
        FusionRunEvent(
            event_seq=1,
            run_id=run_id,
            trace_id=trace_id,
            state="failed",
            status="failed",
            event_type="error_recorded",
            payload={"error": error.model_dump(mode="json")},
        )
    )

    summary = store.read_summary(run_id)
    assert summary.state == "failed"
    assert summary.terminal_error is not None
    assert summary.terminal_error.error_code == "SyntheticFailure"


def test_run_store_idempotency_index_round_trips(tmp_path) -> None:
    store = FileSystemRunStore(tmp_path / "runs")
    record = IdempotencyRecord(
        idempotency_key="same-request",
        request_hash="sha256:" + "1" * 64,
        run_id="run_idempotent_001",
        trace_id="trace_idempotent_001",
    )

    store.write_idempotency(record)

    assert store.get_idempotency("same-request") == record
    assert store.get_idempotency("different-request") is None
