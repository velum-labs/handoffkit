from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, FusionMode, ModelEndpoint, SamplingConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.producers import ChatTrajectoryProducer, PanelExhaustedError
from fusionkit_core.types import ChatMessage, ModelResponse


class FailingChatClient:
    """Chat client whose every call raises, to simulate a dead model."""

    def __init__(self, model_id: str, message: str = "provider exploded") -> None:
        self.model_id = model_id
        self._message = message

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Any] | None = None,
        tool_choice: Any | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        raise RuntimeError(self._message)

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError(self._message)

    async def aclose(self) -> None:
        return None


def test_config_resolves_default_models() -> None:
    config = _config()

    assert config.endpoint_for("fast").model == "fake-fast"
    assert config.resolved_judge_model == "judge"
    assert config.resolved_synthesizer_model == "judge"


@pytest.mark.asyncio
async def test_panel_runner_generates_self_fusion_candidates() -> None:
    runner = ChatTrajectoryProducer({"fast": FakeModelClient("fast")})

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
    # The fusion result is folded onto the consolidated trajectory's synthesis.
    assert result.metrics["synthesis"]["decision"] == "synthesize"


@pytest.mark.asyncio
async def test_fusion_engine_final_output_is_synthesized_not_top_trajectory() -> None:
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

    assert result.trajectories[0].content == "ranker likes this because it has evidence"
    assert result.content == "synthesized final answer from judge"
    assert result.content != result.trajectories[0].content
    synthesis = result.metrics["synthesis"]
    assert synthesis["decision"] == "synthesize"
    assert synthesis["metrics"]["trajectory_contributions"]
    assert synthesis["metrics"]["trajectory_rejections"]


@pytest.mark.asyncio
async def test_panel_tolerates_single_model_failure() -> None:
    producer = ChatTrajectoryProducer(
        {
            "fast": FakeModelClient("fast", ["fast answer"]),
            "broken": FailingChatClient("broken"),
        }
    )

    trajectories = await producer.generate_panel(
        ["fast", "broken"],
        [ChatMessage(role="user", content="hello")],
        SamplingConfig(),
    )

    assert [t.status for t in trajectories] == ["succeeded", "failed"]
    failed = trajectories[1]
    assert failed.model_id == "broken"
    assert failed.content == ""
    assert failed.metadata["error_code"] == "RuntimeError"
    assert failed.metadata["error_message"] == "provider exploded"


@pytest.mark.asyncio
async def test_panel_raises_when_every_model_fails() -> None:
    producer = ChatTrajectoryProducer(
        {
            "broken_a": FailingChatClient("broken_a", "a down"),
            "broken_b": FailingChatClient("broken_b", "b down"),
        }
    )

    with pytest.raises(PanelExhaustedError):
        await producer.generate_panel(
            ["broken_a", "broken_b"],
            [ChatMessage(role="user", content="hello")],
            SamplingConfig(),
        )


@pytest.mark.asyncio
async def test_self_fusion_tolerates_single_sample_failure() -> None:
    producer = ChatTrajectoryProducer({"fast": FakeModelClient("fast", ["ok"])})

    trajectories = await producer.generate_self_fusion(
        "fast",
        [ChatMessage(role="user", content="hello")],
        SamplingConfig(seed=10),
        temperatures=[0.2, 0.6],
        sample_count=2,
    )

    assert all(t.status == "succeeded" for t in trajectories)

    failing = ChatTrajectoryProducer({"fast": FailingChatClient("fast")})
    with pytest.raises(PanelExhaustedError):
        await failing.generate_self_fusion(
            "fast",
            [ChatMessage(role="user", content="hello")],
            SamplingConfig(seed=10),
            temperatures=[0.2, 0.6],
            sample_count=2,
        )


@pytest.mark.asyncio
async def test_panel_fuses_from_survivor_when_one_model_fails() -> None:
    config = _config(default_mode="panel")
    config.panel_models = ["fast", "broken"]
    clients = {
        "fast": FakeModelClient("fast", ["fast answer with evidence"]),
        "broken": FailingChatClient("broken"),
        "judge": FakeModelClient(
            "judge",
            [
                '{"consensus":["one answer"],"contradictions":[],"unique_insights":[],'
                '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":["short"]}',
                "fused final answer",
            ],
        ),
    }
    engine = FusionEngine(config=config, clients=clients)

    result = await engine.run([ChatMessage(role="user", content="Compare options")])

    assert result.content == "fused final answer"
    statuses = sorted(t.status for t in result.trajectories)
    assert statuses == ["failed", "succeeded"]
    assert result.metrics["succeeded_trajectory_count"] == 1
    assert result.metrics["failed_trajectory_count"] == 1


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
