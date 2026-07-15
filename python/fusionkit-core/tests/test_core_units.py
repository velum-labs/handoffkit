from __future__ import annotations

import json
from pathlib import Path

from fusionkit_core.artifacts import LocalArtifactStore, hash_bytes, hash_text
from fusionkit_core.metrics import JsonlRunLogger, RunRecord
from fusionkit_core.router import FusionModeRouter
from fusionkit_core.trace import (
    context_from_headers,
    context_of_span,
    emit_event,
    fusion_span,
    setup_fusion_tracing,
    start_fusion_span,
)
from fusionkit_core.types import ChatMessage
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def _user(content: str) -> list[ChatMessage]:
    return [ChatMessage(role="user", content=content)]


def test_router_routes_hard_keywords_to_panel() -> None:
    decision = FusionModeRouter().route(_user("please benchmark these options"))
    assert decision.route == "panel"
    assert "hard keyword" in decision.reasons


def test_router_routes_long_prompts_to_panel() -> None:
    decision = FusionModeRouter().route(_user(" ".join(["word"] * 121)))
    assert decision.route == "panel"
    assert "long prompt" in decision.reasons


def test_router_routes_medium_keywords_to_self() -> None:
    decision = FusionModeRouter().route(_user("help me debug this"))
    assert decision.route == "self"
    assert "medium keyword" in decision.reasons


def test_router_routes_short_simple_prompts_to_single() -> None:
    decision = FusionModeRouter().route(_user("hello there"))
    assert decision.route == "single"


def test_artifacts_hash_helpers_are_sha256_prefixed() -> None:
    assert hash_text("abc") == hash_bytes(b"abc")
    assert hash_text("abc").startswith("sha256:")
    assert len(hash_text("abc").split(":")[1]) == 64


def test_local_artifact_store_writes_and_returns_ref(tmp_path) -> None:
    store = LocalArtifactStore(tmp_path / "runs")
    ref = store.write_text("run_1", "artifact_1", "transcript", "hello world")
    assert ref.artifact_id == "artifact_1"
    assert ref.kind == "transcript"
    assert ref.hash == hash_text("hello world")
    assert ref.uri is not None
    assert Path(ref.uri).read_text(encoding="utf-8") == "hello world"


def test_metrics_logger_appends_jsonl_records(tmp_path) -> None:
    logger = JsonlRunLogger(tmp_path / "metrics" / "runs.jsonl")
    logger.append(
        RunRecord(
            id="run_1",
            mode="single",
            model_ids=["m1"],
            prompt="p",
            output="o",
            latency_s=1.5,
        )
    )
    logger.append(
        RunRecord(id="run_2", mode="panel", model_ids=["m1", "m2"], prompt="p2", output="o2")
    )
    lines = (tmp_path / "metrics" / "runs.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["id"] == "run_1"
    assert first["latency_s"] == 1.5


_EXPORTER = InMemorySpanExporter()
_LOG_EXPORTER = InMemoryLogRecordExporter()


def _setup_tracing() -> InMemorySpanExporter:
    setup_fusion_tracing(
        "core-units-test",
        extra_processors=[SimpleSpanProcessor(_EXPORTER)],
        extra_log_processors=[SimpleLogRecordProcessor(_LOG_EXPORTER)],
    )
    return _EXPORTER


_TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"


def test_fusion_span_continues_an_incoming_w3c_trace() -> None:
    exporter = _setup_tracing()
    exporter.clear()
    ctx = context_from_headers({"traceparent": _TRACEPARENT})
    assert ctx is not None
    with fusion_span("synthesis", "fusion.fuse", ctx, {"fusion.fusion_unit": "trajectory"}):
        pass
    (span,) = exporter.get_finished_spans()
    assert span.name == "fusion.fuse"
    assert span.context is not None
    assert format(span.context.trace_id, "032x") == "11111111111111111111111111111111"
    assert span.attributes is not None
    assert span.attributes["fusion.fusion_unit"] == "trajectory"
    assert span.attributes.get("fusion.status") != "failed"


def test_fusion_span_marks_failures_and_reraises() -> None:
    exporter = _setup_tracing()
    exporter.clear()
    ctx = context_from_headers({"traceparent": _TRACEPARENT})
    try:
        with fusion_span("synthesis", "fusion.fuse", ctx):
            raise ValueError("synth exploded")
    except ValueError:
        pass
    (span,) = exporter.get_finished_spans()
    assert span.attributes is not None
    assert span.attributes["fusion.status"] == "failed"
    assert "synth exploded" in str(span.attributes["fusion.error"])


def test_events_correlate_to_their_span_and_drop_without_context() -> None:
    exporter = _setup_tracing()
    exporter.clear()
    _LOG_EXPORTER.clear()
    # No ambient context: a signal with no trace identity has no consumer.
    emit_event("judge", "fusion.judge.thinking", None, {"fusion.raw_analysis": "hmm"})
    assert _LOG_EXPORTER.get_finished_logs() == ()

    ctx = context_from_headers({"traceparent": _TRACEPARENT})
    span = start_fusion_span("judge", "fusion.judge", ctx)
    assert span is not None
    emit_event(
        "judge",
        "fusion.judge.thinking",
        context_of_span(span, ctx),
        {"fusion.raw_analysis": "hmm"},
    )
    span.end()
    judge = next(item for item in exporter.get_finished_spans() if item.name == "fusion.judge")
    (readable,) = _LOG_EXPORTER.get_finished_logs()
    event = readable.log_record
    assert event.event_name == "fusion.judge.thinking"
    assert event.attributes is not None
    assert event.attributes["fusion.raw_analysis"] == "hmm"
    assert judge.context is not None
    assert event.span_id == judge.context.span_id
    assert event.trace_id == judge.context.trace_id


def test_context_from_headers_requires_a_traceparent() -> None:
    assert context_from_headers(None) is None
    assert context_from_headers({}) is None
    assert context_from_headers({"baggage": "a=b"}) is None
