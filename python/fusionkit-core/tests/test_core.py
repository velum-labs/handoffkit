from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.producers import (
    ChatTrajectoryProducer,
    PanelExhaustedError,
    trajectory_from_response,
)
from fusionkit_core.types import ChatMessage, ModelResponse
from pydantic import ValidationError


class FailingChatClient:
    """Chat client whose every call raises, to simulate a dead model."""

    def __init__(self, model_id: str, message: str = "RouteKit call failed") -> None:
        self.model_id = model_id
        self.max_context: int | None = None
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

    assert config.require_model("test/fast") == "test/fast"
    assert config.resolved_judge_model == "test/judge"
    assert config.resolved_synthesizer_model == "test/judge"


def test_config_rejects_removed_provider_and_pricing_fields() -> None:
    payload = _config().model_dump()
    payload["endpoints"] = [{"id": "fast", "provider": "openai"}]
    with pytest.raises(ValidationError):
        FusionConfig.model_validate(payload)

    payload = _config().model_dump()
    payload["budget"]["max_cost"] = 1.0
    with pytest.raises(ValidationError):
        FusionConfig.model_validate(payload)


@pytest.mark.asyncio
async def test_panel_runner_generates_self_fusion_candidates() -> None:
    runner = ChatTrajectoryProducer({"test/fast": FakeModelClient("test/fast")})

    candidates = await runner.generate_self_fusion(
        "test/fast",
        [ChatMessage(role="user", content="Explain model fusion")],
        SamplingConfig(seed=10),
        temperatures=[0.2, 0.6],
        sample_count=2,
    )

    assert [candidate.model_id for candidate in candidates] == ["test/fast", "test/fast"]
    assert candidates[0].metadata["temperature"] == 0.2
    assert candidates[1].metadata["seed"] == 11


def test_trajectory_from_response_persists_reasoning_as_item() -> None:
    # A panel model's out-of-band reasoning becomes a `reasoning` trajectory
    # item so the judge/synthesizer see it as evidence.
    response = ModelResponse(model_id="test/fast", content="the answer", reasoning="thought first")
    trajectory = trajectory_from_response("test/fast", response)

    assert trajectory.content == "the answer"
    assert len(trajectory.items) == 1
    assert trajectory.items[0].type == "reasoning"
    assert trajectory.items[0].text == "thought first"

    # No reasoning -> the historical zero-item trajectory.
    bare = trajectory_from_response(
        "test/fast", ModelResponse(model_id="test/fast", content="x")
    )
    assert bare.items == []


def test_trajectory_from_response_caps_reasoning_length() -> None:
    response = ModelResponse(model_id="test/fast", content="ok", reasoning="r" * 10_000)
    trajectory = trajectory_from_response("test/fast", response)

    text = trajectory.items[0].text
    assert text is not None
    assert text.endswith("...[truncated]")
    assert len(text) < 5_000


@pytest.mark.asyncio
async def test_panel_reasoning_flows_into_trajectory_items() -> None:
    producer = ChatTrajectoryProducer(
        {"test/fast": FakeModelClient("test/fast", ["answer"], reasoning="panel thinking")}
    )

    trajectories = await producer.generate_panel(
        ["test/fast"], [ChatMessage(role="user", content="hello")], SamplingConfig()
    )

    assert trajectories[0].items[0].type == "reasoning"
    assert trajectories[0].items[0].text == "panel thinking"


@pytest.mark.asyncio
async def test_fusion_engine_runs_router_to_panel() -> None:
    config = _config(default_mode="heuristic")
    clients = {
        "test/fast": FakeModelClient("test/fast", ["fast answer with evidence"]),
        "test/judge": FakeModelClient(
            "test/judge",
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
    config.panel_models = ["test/fast", "test/writer"]
    clients = {
        "test/fast": FakeModelClient(
            "test/fast", ["ranker likes this because it has evidence"]
        ),
        "test/writer": FakeModelClient("test/writer", ["short draft"]),
        "test/judge": FakeModelClient(
            "test/judge",
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
            "test/fast": FakeModelClient("test/fast", ["fast answer"]),
            "test/broken": FailingChatClient("test/broken"),
        }
    )

    trajectories = await producer.generate_panel(
        ["test/fast", "test/broken"],
        [ChatMessage(role="user", content="hello")],
        SamplingConfig(),
    )

    assert [t.status for t in trajectories] == ["succeeded", "failed"]
    failed = trajectories[1]
    assert failed.model_id == "test/broken"
    assert failed.content == ""
    assert failed.metadata["error_code"] == "RuntimeError"
    assert failed.metadata["error_message"] == "RouteKit call failed"


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
    producer = ChatTrajectoryProducer({"test/fast": FakeModelClient("test/fast", ["ok"])})

    trajectories = await producer.generate_self_fusion(
        "test/fast",
        [ChatMessage(role="user", content="hello")],
        SamplingConfig(seed=10),
        temperatures=[0.2, 0.6],
        sample_count=2,
    )

    assert all(t.status == "succeeded" for t in trajectories)

    failing = ChatTrajectoryProducer({"test/fast": FailingChatClient("test/fast")})
    with pytest.raises(PanelExhaustedError):
        await failing.generate_self_fusion(
            "test/fast",
            [ChatMessage(role="user", content="hello")],
            SamplingConfig(seed=10),
            temperatures=[0.2, 0.6],
            sample_count=2,
        )


@pytest.mark.asyncio
async def test_judge_synthesize_uses_request_max_tokens_over_config_default() -> None:
    class CaptureSynth:
        model_id = "test/synth"
        max_context = None

        def __init__(self) -> None:
            self.captured: list[SamplingConfig] = []

        async def chat(
            self,
            messages: Sequence[ChatMessage],
            sampling: SamplingConfig | None = None,
            tools: Sequence[Any] | None = None,
            tool_choice: Any | None = None,
            extra: Mapping[str, Any] | None = None,
        ) -> ModelResponse:
            self.captured.append(sampling or SamplingConfig())
            return ModelResponse(model_id=self.model_id, content="synthesized answer")

        def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("stream_chat should not be called")

        async def aclose(self) -> None:
            return None

    synth = CaptureSynth()
    config = _config(default_mode="panel")
    config.sampling = SamplingConfig(max_tokens=1024)
    config.synthesizer_model = "test/synth"
    clients = {
        "test/fast": FakeModelClient("test/fast", ["panel member answer"]),
        "test/judge": FakeModelClient(
            "test/judge",
            [
                '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
                '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
            ],
        ),
        "test/synth": synth,
    }
    engine = FusionEngine(config=config, clients=clients)

    result = await engine.run(
        [ChatMessage(role="user", content="fuse this")],
        sampling=SamplingConfig(max_tokens=8000),
    )

    assert result.content == "synthesized answer"
    assert synth.captured[-1].max_tokens == 8000


@pytest.mark.asyncio
async def test_panel_fuses_from_survivor_when_one_model_fails() -> None:
    config = _config(default_mode="panel")
    config.panel_models = ["test/fast", "test/broken"]
    clients = {
        "test/fast": FakeModelClient("test/fast", ["fast answer with evidence"]),
        "test/broken": FailingChatClient("test/broken"),
        "test/judge": FakeModelClient(
            "test/judge",
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


def test_default_mode_is_named_heuristic() -> None:
    # Honesty rename (WS8.5): the default mode is keyword-matching routing, so
    # it is called "heuristic" — "router" oversold 63 lines of substring rules.
    config = FusionConfig(
        routekit_url="http://routekit.test",
        routekit_model_ids=["test/m"],
        default_model="test/m",
    )
    assert config.default_mode == "heuristic"


@pytest.mark.parametrize(
    "overrides",
    [
        {"default_model": "missing"},
        {"judge_model": "missing"},
        {"synthesizer_model": "missing"},
        {"panel_models": ["missing"]},
        {"panel_models": ["m", "m"]},
        {"sample_count": 0},
    ],
)
def test_config_rejects_invalid_model_references_and_counts(
    overrides: dict[str, object],
) -> None:
    payload: dict[str, object] = {
        "routekit_url": "http://routekit.test",
        "routekit_model_ids": ["test/m"],
        "default_model": "test/m",
        **overrides,
    }
    with pytest.raises(ValidationError):
        FusionConfig.model_validate(payload)


def test_config_rejects_duplicate_routekit_model_ids() -> None:
    with pytest.raises(ValidationError):
        FusionConfig(
            routekit_url="http://routekit.test",
            routekit_model_ids=["test/same", "test/same"],
            default_model="test/same",
        )


def _config(default_mode: FusionMode = "single") -> FusionConfig:
    return FusionConfig(
        routekit_url="http://routekit.test",
        routekit_model_ids=[
            "test/fast",
            "test/judge",
            "test/writer",
            "test/broken",
            "test/synth",
        ],
        default_model="test/fast",
        judge_model="test/judge",
        default_mode=default_mode,
        panel_models=["test/fast"],
    )
