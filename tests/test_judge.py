from __future__ import annotations

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import HarnessTrajectoryV1, contract_metadata
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.types import Candidate, ChatMessage


def _trajectory(trajectory_id: str, model_id: str, final_output: str, verified: bool) -> HarnessTrajectoryV1:
    return HarnessTrajectoryV1.model_validate(
        {
            **contract_metadata("harness-trajectory.v1"),
            "trajectory_id": trajectory_id,
            "model_id": model_id,
            "status": "succeeded",
            "steps": [
                {"index": 0, "type": "tool_call", "tool_name": "read_file", "tool_input": "calculator.js"},
                {"index": 1, "type": "observation", "text": "add subtracts"},
                {"index": 2, "type": "output", "text": final_output},
            ],
            "final_output": final_output,
            "verification": {
                "status": "succeeded" if verified else "failed",
                "exit_code": 0 if verified else 1,
            },
        }
    )


@pytest.mark.asyncio
async def test_synthesize_trajectories_fuses_into_first_person_answer() -> None:
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
        _trajectory("traj_alpha", "alpha", "Changed add to left + right.", verified=True),
        _trajectory("traj_beta", "beta", "Rewrote add as a function.", verified=False),
    ]

    result = await synthesizer.synthesize_trajectories(
        [ChatMessage(role="user", content="Fix the failing add() test.")],
        trajectories,
        judge_client=judge,
        synthesizer_client=judge,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert result.record.schema_name == "judge-synthesis-record.v1"
    assert result.record.decision == "synthesize"
    assert result.record.input_candidate_ids == ["traj_alpha", "traj_beta"]
    assert result.final_output == "I fixed add() to return left + right; the test passes."
    assert result.record.metrics is not None
    assert result.record.metrics["fusion_unit"] == "trajectory"
    contributions = result.record.metrics["trajectory_contributions"]
    assert contributions[0]["verification_status"] == "succeeded"
    assert contributions[1]["verification_status"] == "failed"


@pytest.mark.asyncio
async def test_judge_synthesizer_emits_contract_record_with_candidate_metadata() -> None:
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
        Candidate(
            id="candidate_1",
            model_id="fast",
            content="grounded answer because evidence",
            rank=1,
            score=2.0,
        ),
        Candidate(id="candidate_2", model_id="writer", content="terse", rank=2, score=1.0),
    ]

    result = await synthesizer.synthesize(
        [ChatMessage(role="user", content="Compare")],
        candidates,
        judge_client=judge,
        synthesizer_client=judge,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert result.record.schema_name == "judge-synthesis-record.v1"
    assert result.record.final_output == "combined answer"
    assert result.record.metrics is not None
    assert result.record.metrics["candidate_ranks"][0]["candidate_id"] == "candidate_1"
    assert result.record.metrics["candidate_rejections"][0]["candidate_id"] == "candidate_2"
    assert result.record.metrics["judge_structured_parse_status"] == "parsed"


@pytest.mark.asyncio
async def test_judge_synthesizer_marks_invalid_structured_json() -> None:
    synthesizer = JudgeSynthesizer()
    judge = FakeModelClient("judge", ["not json", "fallback answer"])
    candidates = [
        Candidate(
            id="candidate_1",
            model_id="fast",
            content="grounded answer because evidence",
            rank=1,
            score=1.0,
        ),
    ]

    result = await synthesizer.synthesize(
        [ChatMessage(role="user", content="Compare")],
        candidates,
        judge_client=judge,
        synthesizer_client=judge,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert result.record.metrics is not None
    assert result.record.metrics["judge_structured_parse_status"] == "failed"
    assert result.record.metrics["judge_structured_parse_error"] == "invalid_json"
