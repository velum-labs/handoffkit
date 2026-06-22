from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from fusionkit_core.config import FusionConfig, PromptOverrides, SamplingConfig
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    SYSTEM_PROMPT_DEFAULTS,
    TRAJECTORY_STEP_SYSTEM_PROMPT,
)
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, Trajectory


class RecordingClient:
    """A ChatClient that records the system prompts it receives."""

    def __init__(self, model_id: str, responses: Sequence[str]) -> None:
        self.model_id = model_id
        self._responses = list(responses)
        self._calls = 0
        self.system_prompts: list[str] = []

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del sampling, tools, tool_choice, extra
        for message in messages:
            if message.role == "system":
                self.system_prompts.append(message.content)
        content = self._responses[self._calls % len(self._responses)]
        self._calls += 1
        return ModelResponse(model_id=self.model_id, content=content)

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del sampling, tools, tool_choice, extra
        for message in messages:
            if message.role == "system":
                self.system_prompts.append(message.content)
        content = self._responses[self._calls % len(self._responses)]
        self._calls += 1
        yield StreamChunk(delta=content)

    async def aclose(self) -> None:
        return None


def _trajectory(trajectory_id: str, model_id: str, final_output: str) -> Trajectory:
    return Trajectory(
        id=trajectory_id,
        model_id=model_id,
        content=final_output,
        status="succeeded",
    )


def test_prompt_overrides_default_to_none() -> None:
    config = FusionConfig.model_validate(
        {"endpoints": [{"id": "a", "model": "m", "base_url": "http://x"}], "default_model": "a"}
    )
    assert config.prompts == PromptOverrides()
    assert config.prompts.judge_system is None


def test_prompt_overrides_parsed_from_config_mapping() -> None:
    config = FusionConfig.model_validate(
        {
            "endpoints": [{"id": "a", "model": "m", "base_url": "http://x"}],
            "default_model": "a",
            "prompts": {
                "judge_system": "CUSTOM JUDGE",
                "synthesizer_system": "CUSTOM SYNTH",
            },
        }
    )
    assert config.prompts.judge_system == "CUSTOM JUDGE"
    assert config.prompts.synthesizer_system == "CUSTOM SYNTH"
    # Unset fields stay None so the built-in default is used.
    assert config.prompts.verifier_system is None


@pytest.mark.asyncio
async def test_trajectory_synthesis_uses_prompt_overrides() -> None:
    overrides = PromptOverrides(
        judge_system="OVERRIDE JUDGE",
        synthesizer_system="OVERRIDE SYNTH",
    )
    synthesizer = JudgeSynthesizer(overrides)
    judge = RecordingClient(
        "judge",
        [
            '{"consensus":[],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
        ],
    )
    synth_client = RecordingClient("synth", ["the fused answer"])

    await synthesizer.synthesize(
        [ChatMessage(role="user", content="Fix the bug.")],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert judge.system_prompts == ["OVERRIDE JUDGE"]
    assert synth_client.system_prompts == ["OVERRIDE SYNTH"]


@pytest.mark.asyncio
async def test_trajectory_step_uses_prompt_override() -> None:
    synthesizer = JudgeSynthesizer(PromptOverrides(trajectory_step_system="OVERRIDE STEP"))
    judge = RecordingClient("judge", ["done"])

    await synthesizer.step(
        [ChatMessage(role="user", content="Do the thing.")],
        [_trajectory("traj_a", "alpha", "Did the thing.")],
        judge_client=judge,
        sampling=SamplingConfig(),
    )

    assert len(judge.system_prompts) == 1
    assert judge.system_prompts[0].startswith("OVERRIDE STEP")


@pytest.mark.asyncio
async def test_candidate_synthesis_uses_prompt_overrides() -> None:
    overrides = PromptOverrides(judge_system="OVERRIDE JUDGE", synthesizer_system="OVERRIDE SYNTH")
    synthesizer = JudgeSynthesizer(overrides)
    judge = RecordingClient(
        "judge",
        [
            '{"consensus":[],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
        ],
    )
    synth_client = RecordingClient("synth", ["combined"])

    await synthesizer.synthesize(
        [ChatMessage(role="user", content="Compare")],
        [Trajectory(id="c1", model_id="m", content="answer", rank=1, score=1.0)],
        judge_client=judge,
        synthesizer_client=synth_client,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert judge.system_prompts == ["OVERRIDE JUDGE"]
    assert synth_client.system_prompts == ["OVERRIDE SYNTH"]


@pytest.mark.asyncio
async def test_unset_overrides_fall_back_to_builtins() -> None:
    synthesizer = JudgeSynthesizer()
    judge = RecordingClient(
        "judge",
        [
            '{"consensus":[],"contradictions":[],"unique_insights":[],'
            '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":[]}',
        ],
    )
    synth_client = RecordingClient("synth", ["answer"])

    await synthesizer.synthesize(
        [ChatMessage(role="user", content="Fix the bug.")],
        [_trajectory("traj_a", "alpha", "Fixed it.")],
        judge_client=judge,
        synthesizer_client=synth_client,
        judge_sampling=SamplingConfig(temperature=0.0),
        synthesis_sampling=SamplingConfig(),
    )

    assert judge.system_prompts == [JUDGE_SYSTEM_PROMPT]
    assert synth_client.system_prompts == [SYNTHESIZER_SYSTEM_PROMPT]


def test_system_prompt_defaults_cover_every_override_id() -> None:
    assert set(SYSTEM_PROMPT_DEFAULTS) == {
        "judge",
        "synthesizer",
        "trajectory-step",
        "verifier",
        "panel",
    }
    assert SYSTEM_PROMPT_DEFAULTS["judge"] == JUDGE_SYSTEM_PROMPT
    assert SYSTEM_PROMPT_DEFAULTS["synthesizer"] == SYNTHESIZER_SYSTEM_PROMPT
    assert SYSTEM_PROMPT_DEFAULTS["trajectory-step"] == TRAJECTORY_STEP_SYSTEM_PROMPT
