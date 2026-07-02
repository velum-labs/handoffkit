from __future__ import annotations

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.judge import JudgeSynthesizer, analysis_reasoning_markdown, parse_analysis
from fusionkit_core.types import ChatMessage, FusionAnalysis, StreamChunk, Trajectory


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
async def test_fuse_records_stage_metrics_and_judge_pick() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":["alpha is correct"],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[],'
            '"best_trajectory":"traj_alpha"}',
            "final answer",
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

    # Per-stage usage breakdown for cost/latency attribution.
    assert result.stage_metrics["judge"]["model_id"] == "judge"
    assert result.stage_metrics["judge"]["completion_tokens"] is not None
    assert result.stage_metrics["synthesis"]["model_id"] == "judge"
    assert "skipped" not in result.stage_metrics["synthesis"]
    # The judge's own pick is preserved into the synthesis metrics for the
    # regret decomposition (distinct from the verbatim content match).
    assert result.trajectory is not None
    assert result.trajectory.synthesis is not None
    assert result.trajectory.synthesis.metrics["judge_best_trajectory"] == "traj_alpha"


@pytest.mark.asyncio
async def test_fuse_stage_metrics_mark_skipped_synthesis_on_select_best() -> None:
    synthesizer = JudgeSynthesizer(select_best=True)
    judge = FakeModelClient(
        "judge",
        [
            '{"consensus":[],"contradictions":[],"unique_insights":[],"coverage_gaps":[],'
            '"likely_errors":[],"recommended_final_structure":[],'
            '"best_trajectory":"traj_alpha"}',
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

    assert result.response.content == "Changed add to left + right."
    assert result.stage_metrics["judge"]["model_id"] == "judge"
    assert result.stage_metrics["synthesis"]["skipped"] is True


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
