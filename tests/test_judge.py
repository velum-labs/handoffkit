from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fusionkit_core.clients import FakeModelClient, ProviderCallError
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.judge import (
    FuseResult,
    JudgeSynthesizer,
    analysis_reasoning_markdown,
    parse_analysis,
)
from fusionkit_core.types import ChatMessage, FusionAnalysis, ModelResponse, StreamChunk, Trajectory


def _trajectory(trajectory_id: str, model_id: str, final_output: str) -> Trajectory:
    return Trajectory(
        id=trajectory_id,
        model_id=model_id,
        content=final_output,
        status="succeeded",
        items=[
            TrajectoryItem(
                index=0,
                type="function_call",
                name="read_file",
                arguments="calculator.js",
            ),
            TrajectoryItem(index=1, type="function_call_output", text="add subtracts"),
            TrajectoryItem(index=2, type="message", text=final_output),
        ],
    )


@pytest.mark.asyncio
async def test_fuse_no_tools_is_terminal_and_folds_synthesis_onto_trajectory() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":["both fixed add"],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":["beta dropped the export"],'
            '"recommended_final_structure":["use verified patch"]}',
            "I fixed add() to return left + right; the test passes.",
        ],
    )
    trajectories = [
        _trajectory("traj_alpha", "alpha", "Changed add to left + right."),
        _trajectory("traj_beta", "beta", "Rewrote add as a function."),
    ]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix the failing add() test.")],
        trajectories,
        judge_client=judge,
        synthesizer_client=judge,
        sampling=SamplingConfig(),
        tools=None,
    )

    # No tools => terminal on turn 1 (the old one-shot text fusion).
    assert result.terminal is True
    assert result.response.content == "I fixed add() to return left + right; the test passes."
    assert result.trajectory is not None
    synthesis = result.trajectory.synthesis
    assert synthesis is not None
    assert synthesis.decision == "synthesize"
    assert synthesis.input_trajectory_ids == ["traj_alpha", "traj_beta"]
    assert synthesis.metrics["fusion_unit"] == "trajectory"
    contributions = synthesis.metrics["trajectory_contributions"]
    assert contributions[0]["trajectory_id"] == "traj_alpha"
    assert contributions[1]["trajectory_id"] == "traj_beta"


@pytest.mark.asyncio
async def test_fuse_synthesis_metrics_carry_contributions_and_rejections() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":["candidate one is grounded"],"contradictions":[],'
            '"unique_insights":[],"coverage_gaps":[],"likely_errors":["candidate two is terse"],'
            '"recommended_final_structure":["combine"]}',
            "combined answer",
        ],
    )
    candidates = [
        Trajectory(
            id="candidate_1",
            model_id="fast",
            content="grounded answer because evidence",
        ),
        Trajectory(id="candidate_2", model_id="writer", content="terse"),
    ]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Compare")],
        candidates,
        judge_client=judge,
        synthesizer_client=judge,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.response.content == "combined answer"
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    metrics = result.trajectory.synthesis.metrics
    assert metrics["trajectory_contributions"][0]["trajectory_id"] == "candidate_1"
    assert metrics["trajectory_rejections"][0]["trajectory_id"] == "candidate_2"
    assert metrics["judge_structured_parse_status"] == "parsed"


@pytest.mark.asyncio
async def test_fuse_marks_invalid_structured_json() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", ["not json", "fallback answer"])
    candidates = [
        Trajectory(
            id="candidate_1",
            model_id="fast",
            content="grounded answer because evidence",
        ),
    ]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Compare")],
        candidates,
        judge_client=judge,
        synthesizer_client=judge,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    metrics = result.trajectory.synthesis.metrics
    assert metrics["judge_structured_parse_status"] == "failed"
    assert metrics["judge_structured_parse_error"] == "invalid_json"


@pytest.mark.asyncio
async def test_fuse_stream_yields_judge_reasoning_before_content() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":["both fixed add"],"contradictions":["beta rewrote the API"],'
            '"unique_insights":[],"coverage_gaps":[],"likely_errors":["beta dropped the export"],'
            '"recommended_final_structure":[],"best_trajectory":"traj_alpha"}',
            "the fused answer",
        ],
    )
    trajectories = [
        _trajectory("traj_alpha", "alpha", "Changed add to left + right."),
        _trajectory("traj_beta", "beta", "Rewrote add as a function."),
    ]

    items = [
        item
        async for item in synthesizer.fuse_stream(
            [ChatMessage(role="user", content="Fix the failing add() test.")],
            trajectories,
            judge_client=judge,
            synthesizer_client=judge,
            sampling=SamplingConfig(),
            tools=None,
        )
    ]

    chunks = [item for item in items if isinstance(item, StreamChunk)]
    reasoning_indexes = [i for i, c in enumerate(chunks) if c.reasoning_delta]
    content_indexes = [i for i, c in enumerate(chunks) if c.delta]
    assert reasoning_indexes, "the judge's analysis streams on the reasoning channel"
    assert content_indexes, "the fused answer still streams as content"
    assert max(reasoning_indexes) < min(content_indexes), "reasoning strictly precedes content"

    reasoning = chunks[reasoning_indexes[0]].reasoning_delta or ""
    assert reasoning.startswith("**Weighing the candidates**")
    assert "alpha looks strongest." in reasoning
    assert "both fixed add" in reasoning
    assert "beta dropped the export" in reasoning


@pytest.mark.asyncio
async def test_fuse_non_stream_carries_judge_reasoning_on_response() -> None:
    # Parity with fuse_stream's Act III: a non-stream terminal response carries
    # the judge's analysis on its reasoning field (serialized by the server as
    # `reasoning_content`), ahead of any synthesizer-model reasoning.
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":["both fixed add"],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[],'
            '"best_trajectory":"traj_alpha"}',
            "the fused answer",
        ],
    )
    trajectories = [
        _trajectory("traj_alpha", "alpha", "Changed add to left + right."),
        _trajectory("traj_beta", "beta", "Rewrote add as a function."),
    ]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix the failing add() test.")],
        trajectories,
        judge_client=judge,
        synthesizer_client=judge,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.terminal is True
    assert result.response.reasoning is not None
    assert result.response.reasoning.startswith("**Weighing the candidates**")
    assert "alpha looks strongest." in result.response.reasoning


@pytest.mark.asyncio
async def test_fuse_non_stream_skips_reasoning_when_judge_degraded() -> None:
    # Sentinel analyses (parse failure / degraded judge) must not leak into the
    # reasoning channel — mirrors analysis_reasoning_markdown's guard.
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", ["not json", "fallback answer"])
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add to left + right.")]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix it.")],
        trajectories,
        judge_client=judge,
        synthesizer_client=judge,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert result.terminal is True
    assert result.response.reasoning is None


@pytest.mark.asyncio
async def test_fuse_stream_folds_synth_model_reasoning_into_result() -> None:
    # A streamed synthesizer's own reasoning tokens (model_reasoning_delta)
    # accumulate onto the terminal FuseResult response — trace/session parity
    # with the non-stream path.
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", [_VALID_ANALYSIS_JSON])
    synth = FakeModelClient("synth", ["the fused answer"], reasoning="synth thinking")
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add to left + right.")]

    items = [
        item
        async for item in synthesizer.fuse_stream(
            [ChatMessage(role="user", content="Fix it.")],
            trajectories,
            judge_client=judge,
            synthesizer_client=synth,
            sampling=SamplingConfig(),
            tools=None,
        )
    ]

    result = items[-1]
    assert isinstance(result, FuseResult)
    assert result.response.reasoning == "synth thinking"
    # The raw model reasoning still streamed out-of-band as token deltas.
    model_deltas = [
        item.model_reasoning_delta
        for item in items
        if isinstance(item, StreamChunk) and item.model_reasoning_delta
    ]
    assert model_deltas == ["synth thinking"]


def _overflow_error() -> ProviderCallError:
    return ProviderCallError(
        "prompt is too long", category="context_overflow", provider="openai", status_code=400
    )


class _FlakyOverflowClient:
    """Raises a classified context overflow for the first ``fail_times`` calls."""

    def __init__(self, model_id: str, responses: list[str], *, fail_times: int) -> None:
        self.model_id = model_id
        self.max_context: int | None = None
        self.calls = 0
        self._responses = responses
        self._fail_times = fail_times

    async def chat(self, *args: Any, **kwargs: Any) -> ModelResponse:
        self.calls += 1
        if self.calls <= self._fail_times:
            raise _overflow_error()
        content = self._responses[(self.calls - 1) % len(self._responses)]
        return ModelResponse(model_id=self.model_id, content=content)

    async def _stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        response = await self.chat(*args, **kwargs)
        yield StreamChunk(delta=response.content)
        yield StreamChunk(finish_reason="stop")

    def stream_chat(self, *args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        return self._stream(*args, **kwargs)

    async def aclose(self) -> None:
        return None


def _flaky(model_id: str, responses: list[str], *, fail_times: int) -> _FlakyOverflowClient:
    return _FlakyOverflowClient(model_id, responses, fail_times=fail_times)


_VALID_ANALYSIS_JSON = (
    '{"consensus":["both fixed add"],"contradictions":[],"unique_insights":[],'
    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[],'
    '"best_trajectory":"traj_alpha"}'
)


@pytest.mark.asyncio
async def test_judge_overflow_degrades_to_empty_analysis_and_turn_still_fuses() -> None:
    synthesizer = JudgeSynthesizer()
    judge = _flaky("judge", [], fail_times=10)  # every judge call overflows
    synth = FakeModelClient("synth", ["fused despite the judge"])
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add to left + right.")]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix add().")],
        trajectories,
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=None,
    )

    # The overflow was retried once (tighter pack), then degraded — never raised.
    assert judge.calls == 2
    assert result.response.content == "fused despite the judge"
    assert result.trajectory is not None and result.trajectory.synthesis is not None
    context_metrics = result.trajectory.synthesis.metrics["context"]
    assert context_metrics["judge_degraded"] == "context_overflow"
    # The degraded sentinel never leaks into the reasoning channel.
    assert analysis_reasoning_markdown(result.analysis, trajectories) is None


@pytest.mark.asyncio
async def test_judge_non_overflow_provider_error_degrades_immediately() -> None:
    synthesizer = JudgeSynthesizer()
    judge = _flaky("judge", [], fail_times=10)
    # Rewrite the error to a non-overflow category.
    original_chat = judge.chat

    async def _auth_error_chat(*args: Any, **kwargs: Any) -> ModelResponse:
        try:
            return await original_chat(*args, **kwargs)
        except ProviderCallError:
            raise ProviderCallError(
                "bad key", category="auth_permanent", provider="openai"
            ) from None

    judge.chat = _auth_error_chat  # type: ignore[method-assign]
    synth = FakeModelClient("synth", ["still answers"])
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add.")]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix add().")],
        trajectories,
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert judge.calls == 1  # no pointless tighter retry for a non-overflow failure
    assert result.response.content == "still answers"
    assert result.trajectory is not None and result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.metrics["context"]["judge_degraded"] == "auth_permanent"


@pytest.mark.asyncio
async def test_judge_overflow_retry_succeeds_at_half_budget() -> None:
    synthesizer = JudgeSynthesizer()
    judge = _flaky("judge", [_VALID_ANALYSIS_JSON], fail_times=1)
    synth = FakeModelClient("synth", ["fused"])
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add.")]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix add().")],
        trajectories,
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert judge.calls == 2
    assert result.analysis.best_trajectory == "traj_alpha"
    assert result.response.content == "fused"


@pytest.mark.asyncio
async def test_synth_overflow_retries_with_reduced_evidence() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", [_VALID_ANALYSIS_JSON])
    synth = _flaky("synth", ["fused on the retry"], fail_times=1)
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add to left + right.")]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix add().")],
        trajectories,
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert synth.calls == 2
    assert result.response.content == "fused on the retry"
    assert result.trajectory is not None and result.trajectory.synthesis is not None
    context_metrics = result.trajectory.synthesis.metrics["context"]
    assert context_metrics["synth_fallback"] == "reduced_evidence_retry"


@pytest.mark.asyncio
async def test_synth_overflow_falls_back_to_judge_selected_candidate_verbatim() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", [_VALID_ANALYSIS_JSON])
    synth = _flaky("synth", [], fail_times=10)  # every synth call overflows
    trajectories = [
        _trajectory("traj_alpha", "alpha", "Changed add to left + right."),
        _trajectory("traj_beta", "beta", "Rewrote add as a function."),
    ]

    result = await synthesizer.fuse(
        [ChatMessage(role="user", content="Fix add().")],
        trajectories,
        judge_client=judge,
        synthesizer_client=synth,
        sampling=SamplingConfig(),
        tools=None,
    )

    assert synth.calls == 2  # initial + reduced-evidence retry, then verbatim fallback
    assert result.terminal is True
    assert result.response.content == "Changed add to left + right."
    assert result.trajectory is not None and result.trajectory.synthesis is not None
    metrics = result.trajectory.synthesis.metrics
    assert metrics["context"]["synth_fallback"] == "select_best_verbatim"
    # The fallback content matches a candidate, so the decision records selection.
    assert result.trajectory.synthesis.decision == "select_trajectory"


@pytest.mark.asyncio
async def test_synth_non_overflow_error_still_propagates() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", [_VALID_ANALYSIS_JSON])

    class _AuthFailingClient:
        model_id = "synth"
        max_context = None

        async def chat(self, *args: Any, **kwargs: Any) -> ModelResponse:
            raise ProviderCallError("bad key", category="auth_permanent", provider="openai")

        def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
            raise NotImplementedError

        async def aclose(self) -> None:
            return None

    with pytest.raises(ProviderCallError) as excinfo:
        await synthesizer.fuse(
            [ChatMessage(role="user", content="Fix add().")],
            [_trajectory("traj_alpha", "alpha", "Changed add.")],
            judge_client=judge,
            synthesizer_client=_AuthFailingClient(),
            sampling=SamplingConfig(),
            tools=None,
        )
    assert excinfo.value.category == "auth_permanent"


@pytest.mark.asyncio
async def test_fuse_stream_overflow_falls_back_to_candidate_as_single_chunk() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", [_VALID_ANALYSIS_JSON])
    synth = _flaky("synth", [], fail_times=10)
    trajectories = [_trajectory("traj_alpha", "alpha", "Changed add to left + right.")]

    items = [
        item
        async for item in synthesizer.fuse_stream(
            [ChatMessage(role="user", content="Fix add().")],
            trajectories,
            judge_client=judge,
            synthesizer_client=synth,
            sampling=SamplingConfig(),
            tools=None,
        )
    ]

    chunks = [item for item in items if isinstance(item, StreamChunk)]
    deltas = [chunk.delta for chunk in chunks if chunk.delta]
    assert deltas == ["Changed add to left + right."]
    results = [item for item in items if isinstance(item, FuseResult)]
    assert len(results) == 1
    assert results[0].terminal is True
    assert results[0].response.content == "Changed add to left + right."


def test_analysis_reasoning_markdown_skips_unparseable_judge_output() -> None:
    failed = parse_analysis("not json at all")
    assert analysis_reasoning_markdown(failed, []) is None
    assert analysis_reasoning_markdown(FusionAnalysis(), []) is None


def test_analysis_reasoning_markdown_sanitizes_judge_text() -> None:
    hostile = "**bold**\n`code`\t " + "x" * 500
    text = analysis_reasoning_markdown(FusionAnalysis(consensus=[hostile]), [])
    assert text is not None
    headline, body = text.split("\n\n", 1)
    assert headline == "**Weighing the candidates**"
    assert "*" not in body and "`" not in body and "\n" not in body.strip()
    assert len(body) < 220, "judge text is hard-capped per line"
