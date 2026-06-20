from __future__ import annotations

import json
from pathlib import Path

from fusionkit_core.artifacts import LocalArtifactStore, hash_bytes, hash_text
from fusionkit_core.metrics import JsonlRunLogger, RunRecord
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.trace import TraceEmitter, new_span_id, new_trace_id
from fusionkit_core.types import ChatMessage


def _user(content: str) -> list[ChatMessage]:
    return [ChatMessage(role="user", content=content)]


def test_router_routes_hard_keywords_to_panel() -> None:
    decision = HeuristicRouter().route(_user("please benchmark these options"))
    assert decision.route == "panel"
    assert "hard keyword" in decision.reasons


def test_router_routes_long_prompts_to_panel() -> None:
    decision = HeuristicRouter().route(_user(" ".join(["word"] * 121)))
    assert decision.route == "panel"
    assert "long prompt" in decision.reasons


def test_router_routes_medium_keywords_to_self() -> None:
    decision = HeuristicRouter().route(_user("help me debug this"))
    assert decision.route == "self"
    assert "medium keyword" in decision.reasons


def test_router_routes_short_simple_prompts_to_single() -> None:
    decision = HeuristicRouter().route(_user("hello there"))
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


def test_trace_emitter_disabled_is_a_noop() -> None:
    emitter = TraceEmitter(url=None, directory=None)
    assert emitter.enabled is False
    # Must not raise even though there is no sink configured.
    emitter.emit(component="test", event_type="noop", trace_id=new_trace_id())


def test_trace_emitter_writes_jsonl_to_directory(tmp_path) -> None:
    trace_dir = tmp_path / "traces"
    emitter = TraceEmitter(directory=str(trace_dir))
    assert emitter.enabled is True
    trace_id = new_trace_id()
    emitter.emit(
        component="panel-model",
        event_type="model.call.started",
        trace_id=trace_id,
        span_id=new_span_id(),
        payload={"model": "m1"},
    )
    emitter.close(timeout=2.0)
    path = trace_dir / f"{trace_id}.jsonl"
    assert path.exists()
    event = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert event["trace_id"] == trace_id
    assert event["event_type"] == "model.call.started"
    assert event["component"] == "panel-model"
    assert event["schema"] == "fusion-trace-event.v1"


def test_trace_emitter_skips_when_no_trace_id(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("FUSION_TRACE_ID", raising=False)
    trace_dir = tmp_path / "traces"
    emitter = TraceEmitter(directory=str(trace_dir))
    emitter.emit(component="test", event_type="no.trace")
    emitter.close(timeout=2.0)
    assert list(trace_dir.glob("*.jsonl")) == []
