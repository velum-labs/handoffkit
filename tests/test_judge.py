from __future__ import annotations

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.types import ChatMessage, Trajectory


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
