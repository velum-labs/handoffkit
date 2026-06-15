from __future__ import annotations

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, FusionMode, ModelEndpoint, SamplingConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.panel import PanelRunner
from fusionkit_core.types import ChatMessage


def test_config_resolves_default_models() -> None:
    config = _config()

    assert config.endpoint_for("fast").model == "fake-fast"
    assert config.resolved_judge_model == "judge"
    assert config.resolved_synthesizer_model == "judge"


@pytest.mark.asyncio
async def test_panel_runner_generates_self_fusion_candidates() -> None:
    runner = PanelRunner({"fast": FakeModelClient("fast")})

    candidates = await runner.generate_self_fusion(
        "fast",
        [ChatMessage(role="user", content="Explain model fusion")],
        SamplingConfig(seed=10),
        temperatures=[0.2, 0.6],
        sample_count=2,
    )

    assert [candidate.model_id for candidate in candidates] == ["fast", "fast"]
    assert candidates[0].metadata["temperature"] == 0.2
    assert candidates[1].metadata["seed"] == 11


@pytest.mark.asyncio
async def test_fusion_engine_runs_router_to_panel() -> None:
    config = _config(default_mode="router")
    clients = {
        "fast": FakeModelClient("fast", ["fast answer with evidence"]),
        "judge": FakeModelClient(
            "judge",
            [
                '{"consensus":["answers agree"],"contradictions":[],"unique_insights":[],'
                '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":["short"]}',
                "fused final answer",
            ],
        ),
    }
    engine = FusionEngine(config=config, clients=clients)

    result = await engine.run(
        [ChatMessage(role="user", content="Do deep research and compare options")]
    )

    assert result.route == "panel"
    assert result.content == "fused final answer"
    assert result.analysis is not None
    assert result.analysis.consensus == ["answers agree"]
    assert result.metrics["judge_synthesis_record"]["schema"] == "judge-synthesis-record.v1"
    assert result.metrics["judge_synthesis_record"]["final_output"] == "fused final answer"


@pytest.mark.asyncio
async def test_fusion_engine_final_output_is_not_ranker_selection() -> None:
    config = _config(default_mode="panel")
    config.panel_models = ["fast", "writer"]
    clients = {
        "fast": FakeModelClient("fast", ["ranker likes this because it has evidence"]),
        "writer": FakeModelClient("writer", ["short draft"]),
        "judge": FakeModelClient(
            "judge",
            [
                '{"consensus":["use both"],"contradictions":[],"unique_insights":[],'
                '"coverage_gaps":[],"likely_errors":["short draft lacks support"],'
                '"recommended_final_structure":["synthesized"]}',
                "synthesized final answer from judge",
            ],
        ),
    }
    engine = FusionEngine(config=config, clients=clients)

    result = await engine.run([ChatMessage(role="user", content="Compare options with evidence")])

    assert result.candidates[0].content == "ranker likes this because it has evidence"
    assert result.content == "synthesized final answer from judge"
    assert result.content != result.candidates[0].content
    synthesis_record = result.metrics["judge_synthesis_record"]
    assert synthesis_record["decision"] == "synthesize"
    assert synthesis_record["metrics"]["candidate_contributions"]
    assert synthesis_record["metrics"]["candidate_rejections"]


def _config(default_mode: FusionMode = "single") -> FusionConfig:
    return FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
            ModelEndpoint(id="judge", model="fake-judge", base_url="http://localhost:8102"),
        ],
        default_model="fast",
        judge_model="judge",
        default_mode=default_mode,
        panel_models=["fast"],
    )
