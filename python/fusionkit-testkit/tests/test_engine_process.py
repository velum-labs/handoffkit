"""Process-level harness validation: the REAL ``fusionkit serve`` child
process (the exact entrypoint the Node CLI spawns in production) against the
provider simulator — config file loading, uvicorn startup, and the HTTP
surface all run as shipped.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fusionkit_testkit import (
    Behavior,
    EngineProcess,
    EngineProcessError,
    ProviderSimulator,
    panel_config,
    sim_endpoint,
    sse_text,
)

JUDGE_ANALYSIS = json.dumps(
    {
        "consensus": ["agreement"],
        "contradictions": [],
        "unique_insights": [],
        "coverage_gaps": [],
        "likely_errors": [],
        "recommended_final_structure": [],
    }
)


@pytest.fixture(scope="module")
def stack():
    """One simulator + one real engine process shared by the module's tests."""
    with ProviderSimulator() as sim:
        members = [
            sim_endpoint(sim, id="member-a", model="gpt-panel-a", provider="openai"),
            sim_endpoint(sim, id="member-b", model="claude-panel-b", provider="anthropic"),
        ]
        judge = sim_endpoint(sim, id="judge", model="gpt-judge", provider="openai")
        config = panel_config(sim, members=members, judge=judge)
        with EngineProcess(config) as engine:
            yield sim, engine


def test_engine_process_serves_models_and_health(stack) -> None:
    sim, engine = stack
    del sim
    with httpx.Client(base_url=engine.url, timeout=10.0) as http:
        models = {entry["id"] for entry in http.get("/v1/models").json()["data"]}
    assert {"member-a", "member-b", "judge", "fusionkit/panel"} <= models


def test_engine_process_passthrough_hits_the_simulator(stack) -> None:
    sim, engine = stack
    sim.queue("claude-panel-b", Behavior(reply="process-level passthrough"))
    with httpx.Client(base_url=engine.url, timeout=30.0) as http:
        response = http.post(
            "/v1/chat/completions",
            json={"model": "member-b", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "process-level passthrough"
    assert sim.journal_for("claude-panel-b")[-1]["dialect"] == "anthropic-messages"


def test_engine_process_fused_streaming_end_to_end(stack) -> None:
    sim, engine = stack
    sim.queue("gpt-panel-a", Behavior(reply="candidate A"))
    sim.queue("claude-panel-b", Behavior(reply="candidate B"))
    sim.queue("gpt-judge", Behavior(reply=JUDGE_ANALYSIS), Behavior(reply="fused across processes"))
    with httpx.Client(base_url=engine.url, timeout=60.0) as http:
        response = http.post(
            "/v1/chat/completions",
            json={
                "model": "fusionkit/panel",
                "stream": True,
                "messages": [{"role": "user", "content": "fuse it"}],
            },
        )
    assert response.status_code == 200
    from fusionkit_testkit import parse_sse

    assert sse_text(parse_sse(response.text)) == "fused across processes"


def test_engine_process_startup_failure_carries_the_log(monkeypatch) -> None:
    import fusionkit_testkit.engine as engine_module
    from fusionkit_core.config import FusionConfig, ModelEndpoint

    # Port 1 is unbindable for an unprivileged process, so uvicorn dies on
    # startup: the harness must fail fast and the raised error must carry the
    # engine's own output (a broken engine explains itself).
    monkeypatch.setattr(engine_module, "free_port", lambda host="127.0.0.1": 1)
    config = FusionConfig(
        endpoints=[ModelEndpoint(id="m", model="m", base_url="http://127.0.0.1:9")],
        default_model="m",
    )
    broken = EngineProcess(config, startup_timeout_s=30.0)
    try:
        with pytest.raises(EngineProcessError) as excinfo:
            broken.start()
    finally:
        broken.stop()
    assert "engine log" in str(excinfo.value)
