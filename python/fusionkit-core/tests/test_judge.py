from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import ContextPolicy, SamplingConfig
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.judge import FuseResult, JudgeSynthesizer, parse_analysis
from fusionkit_core.types import (
    ChatMessage,
    FusionAnalysis,
    ModelResponse,
    StreamChunk,
    ToolCall,
    Trajectory,
    Usage,
)

_ANALYSIS = (
    '{"consensus":["both fixed add"],"contradictions":[],"unique_insights":[],'
    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[],'
    '"best_trajectory":"alpha"}'
)


def _trajectory(trajectory_id: str, content: str) -> Trajectory:
    return Trajectory(
        id=trajectory_id,
        model_id=trajectory_id,
        content=content,
        status="succeeded",
    )


class _ScriptedClient:
    def __init__(
        self,
        model_id: str,
        *,
        responses: Sequence[ModelResponse] = (),
        stream: Sequence[StreamChunk] = (),
        max_context: int | None = None,
    ) -> None:
        self.model_id = model_id
        self.max_context = max_context
        self.responses = list(responses)
        self.stream = list(stream)
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del sampling, tools, tool_choice, extra
        self.calls.append(list(messages))
        if not self.responses:
            raise AssertionError(f"unexpected chat call to {self.model_id}")
        return self.responses.pop(0)

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del sampling, tools, tool_choice, extra
        self.calls.append(list(messages))
        for chunk in self.stream:
            yield chunk

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_fuse_is_terminal_and_folds_synthesis_onto_trajectory() -> None:
    client = FakeModelClient("judge", [_ANALYSIS, "fused answer"])
    result = await JudgeSynthesizer().fuse(
        [ChatMessage(role="user", content="Fix add")],
        [_trajectory("alpha", "candidate")],
        judge_client=client,
        synthesizer_client=client,
        sampling=SamplingConfig(),
    )

    assert result.terminal is True
    assert result.response.content == "fused answer"
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.input_trajectory_ids == ["alpha"]


@pytest.mark.asyncio
async def test_select_best_returns_candidate_without_synthesizer_call() -> None:
    client = FakeModelClient("judge", [_ANALYSIS])
    result = await JudgeSynthesizer(select_best=True).fuse(
        [ChatMessage(role="user", content="Pick best")],
        [_trajectory("alpha", "candidate")],
        judge_client=client,
        sampling=SamplingConfig(),
    )

    assert result.response.content == "candidate"
    assert result.synthesizer_called is False
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.decision == "select_trajectory"


def test_parse_analysis_degrades_invalid_json() -> None:
    analysis = parse_analysis("not json")
    assert analysis.consensus == ["Judge did not return valid structured JSON."]


def test_parse_analysis_accepts_fenced_json_and_best_selection() -> None:
    analysis = parse_analysis(f"```json\n{_ANALYSIS}\n```")

    assert analysis.consensus == ["both fixed add"]
    assert analysis.best_trajectory == "alpha"


@pytest.mark.asyncio
async def test_empty_synthesis_falls_back_to_best_successful_candidate() -> None:
    client = FakeModelClient("judge", [_ANALYSIS, ""])
    result = await JudgeSynthesizer().fuse(
        [ChatMessage(role="user", content="Fuse")],
        [_trajectory("alpha", "candidate answer")],
        judge_client=client,
        synthesizer_client=client,
        sampling=SamplingConfig(),
    )

    assert result.synthesis_empty is True
    assert result.response.content == "candidate answer"
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.decision == "select_trajectory"
    assert result.trajectory.synthesis.selected_trajectory_id == "alpha"


@pytest.mark.asyncio
async def test_select_best_unknown_id_falls_back_to_synthesis() -> None:
    analysis = _ANALYSIS.replace('"alpha"', '"missing"')
    judge = FakeModelClient("judge", [analysis])
    synth = FakeModelClient("synth", ["composed answer"])

    result = await JudgeSynthesizer(select_best=True).fuse(
        [ChatMessage(role="user", content="Fuse")],
        [_trajectory("alpha", "candidate answer")],
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
    )

    assert result.response.content == "composed answer"
    assert result.synthesizer_called is True
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.decision == "synthesize"


@pytest.mark.asyncio
async def test_context_reduction_ladder_is_applied_to_judge_and_synthesis() -> None:
    trajectory = Trajectory(
        id="large",
        model_id="panel",
        content="candidate answer",
        items=[
            TrajectoryItem(
                index=index,
                type="function_call_output",
                text=f"evidence-{index}-" + "x" * 500,
                call_id=f"call-{index}",
            )
            for index in range(40)
        ],
    )
    judge = _ScriptedClient(
        "judge",
        responses=[ModelResponse(model_id="judge", content=_ANALYSIS)],
        max_context=2_048,
    )
    synth = _ScriptedClient(
        "synth",
        responses=[ModelResponse(model_id="synth", content="fused")],
        max_context=2_048,
    )

    result = await JudgeSynthesizer(
        context_policy=ContextPolicy(safety_margin_tokens=0)
    ).fuse(
        [ChatMessage(role="user", content="Fuse")],
        [trajectory],
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(max_tokens=256),
    )

    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    context = result.trajectory.synthesis.metrics["context"]
    assert context["judge_pack"]["estimated_tokens_after"] < context["judge_pack"][
        "estimated_tokens_before"
    ]
    assert context["synth_pack"]["estimated_tokens_after"] < context["synth_pack"][
        "estimated_tokens_before"
    ]
    assert "evidence-20-" not in judge.calls[0][-1].content
    assert "evidence-20-" not in synth.calls[0][0].content


@pytest.mark.asyncio
async def test_nonterminal_tool_step_preserves_calls_verbatim() -> None:
    calls = [
        ToolCall(id="call-a", name="read_file", arguments='{"path":"README.md"}'),
        ToolCall(id="call-b", name="search", arguments='{"query":"fusion"}'),
    ]
    synth = _ScriptedClient(
        "synth",
        responses=[
            ModelResponse(
                model_id="synth",
                content="",
                finish_reason="tool_calls",
                tool_calls=calls,
            )
        ],
    )

    result = await JudgeSynthesizer(panel_mode="step").fuse(
        [ChatMessage(role="user", content="Continue")],
        [_trajectory("alpha", "proposal")],
        judge_client=synth,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=[{"name": "read_file"}, {"name": "search"}],
        analysis=FusionAnalysis(best_trajectory="alpha"),
    )

    assert result.terminal is False
    assert result.trajectory is None
    assert result.response.tool_calls == calls


@pytest.mark.asyncio
async def test_stream_reassembles_interleaved_tools_and_accounts_usage() -> None:
    synth = _ScriptedClient(
        "synth",
        stream=[
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="call-a", name="read_file", arguments='{"path":', index=0
                )
            ),
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="call-b", name="search", arguments='{"query":', index=1
                )
            ),
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="", name="", arguments='"README.md"}', index=0
                )
            ),
            StreamChunk(
                tool_call_delta=ToolCall(
                    id="", name="", arguments='"fusion"}', index=1
                )
            ),
            StreamChunk(
                finish_reason="tool_calls",
                usage=Usage(prompt_tokens=11, completion_tokens=4),
            ),
        ],
    )

    items = [
        item
        async for item in JudgeSynthesizer(panel_mode="step").fuse_stream(
            [ChatMessage(role="user", content="Continue")],
            [_trajectory("alpha", "proposal")],
            judge_client=synth,
            synthesizer_client=synth,
            sampling=SamplingConfig(),
            tools=[{"name": "read_file"}, {"name": "search"}],
            analysis=FusionAnalysis(best_trajectory="alpha"),
        )
    ]

    result = items[-1]
    assert isinstance(result, FuseResult)
    assert [(call.id, call.name, call.arguments) for call in result.response.tool_calls] == [
        ("call-a", "read_file", '{"path":"README.md"}'),
        ("call-b", "search", '{"query":"fusion"}'),
    ]
    assert result.response.usage.total_tokens == 15


@pytest.mark.asyncio
async def test_usage_accounting_separates_panel_and_judge_synthesis_turns() -> None:
    trajectory = _trajectory("alpha", "candidate")
    trajectory.metadata["usage"] = {
        "prompt_tokens": 3,
        "completion_tokens": 2,
        "total_tokens": 5,
    }
    judge = _ScriptedClient(
        "judge",
        responses=[
            ModelResponse(
                model_id="judge",
                content=_ANALYSIS,
                usage=Usage(prompt_tokens=6, completion_tokens=4),
            )
        ],
    )
    synth = _ScriptedClient(
        "synth",
        responses=[
            ModelResponse(
                model_id="synth",
                content="fused",
                usage=Usage(prompt_tokens=8, completion_tokens=7),
            )
        ],
    )

    result = await JudgeSynthesizer().fuse(
        [ChatMessage(role="user", content="Fuse")],
        [trajectory],
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
    )

    assert result.turn_usage().total_tokens == 25
    assert result.panel_usage is not None
    assert result.panel_usage.total_tokens == 5
    assert result.panel_trajectory_count == 1


@pytest.mark.asyncio
async def test_stream_yields_judge_reasoning_before_content() -> None:
    judge = FakeModelClient("judge", [_ANALYSIS])
    synth = FakeModelClient("synth", ["fused answer"], reasoning="model thought")
    items = [
        item
        async for item in JudgeSynthesizer().fuse_stream(
            [ChatMessage(role="user", content="Fix add")],
            [_trajectory("alpha", "candidate")],
            judge_client=judge,
            synthesizer_client=synth,
            sampling=SamplingConfig(),
        )
    ]

    assert isinstance(items[0], StreamChunk)
    assert items[0].reasoning_delta is not None
    assert any(
        isinstance(item, StreamChunk) and item.model_reasoning_delta == "model thought"
        for item in items
    )
    assert isinstance(items[-1], FuseResult)
    assert items[-1].response.reasoning == "model thought"


@pytest.mark.asyncio
async def test_failed_judge_call_degrades_without_retrying() -> None:
    class FailingJudge:
        model_id = "judge"
        max_context: int | None = None

        def __init__(self) -> None:
            self.calls = 0

        async def chat(
            self,
            messages: Sequence[ChatMessage],
            sampling: SamplingConfig | None = None,
            tools: Sequence[Mapping[str, Any]] | None = None,
            tool_choice: str | Mapping[str, Any] | None = None,
            extra: Mapping[str, Any] | None = None,
        ) -> ModelResponse:
            self.calls += 1
            raise RuntimeError("RouteKit unavailable")

        def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("not used")

        async def aclose(self) -> None:
            return None

    judge = FailingJudge()
    result = await JudgeSynthesizer().fuse(
        [ChatMessage(role="user", content="Fix add")],
        [_trajectory("alpha", "candidate")],
        judge_client=judge,
        synthesizer_client=FakeModelClient("synth", ["fallback fusion"]),
        sampling=SamplingConfig(),
    )

    assert judge.calls == 1
    assert result.response.content == "fallback fusion"
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.metrics["context"]["judge_degraded"] == "routekit_error"
