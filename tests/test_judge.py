from __future__ import annotations

import pytest
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.types import Candidate, ChatMessage


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
