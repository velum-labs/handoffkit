from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import PromptOverrides, SamplingConfig
from fusionkit_core.contracts import (
    JudgeSynthesisRecordV1,
    contract_metadata,
)
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    TRAJECTORY_STEP_SYSTEM_PROMPT,
    build_judge_prompt,
    build_synthesis_prompt,
    build_trajectory_step_system,
)
from fusionkit_core.trace import emit as trace_emit
from fusionkit_core.trace import new_span_id
from fusionkit_core.types import ChatMessage, FusionAnalysis, ModelResponse, Trajectory


class JudgeSynthesisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record: JudgeSynthesisRecordV1
    final_output: str
    analysis: FusionAnalysis
    ranked_trajectories: list[Trajectory]


class JudgeSynthesizer:
    def __init__(self, prompts: PromptOverrides | None = None) -> None:
        overrides = prompts or PromptOverrides()
        self._judge_system = overrides.judge_system or JUDGE_SYSTEM_PROMPT
        self._synthesizer_system = overrides.synthesizer_system or SYNTHESIZER_SYSTEM_PROMPT
        self._trajectory_step_system = (
            overrides.trajectory_step_system or TRAJECTORY_STEP_SYSTEM_PROMPT
        )

    async def step(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> ModelResponse:
        """One step of the judge acting as a streaming agent on the front door.

        The judge is given the candidate trajectories as reference and the live
        conversation (the consolidated trajectory so far, including any tool
        results the user's harness fed back), and produces the next consolidated
        step: either a tool call for the harness to execute, or the final answer
        when the work is done. Iteration/verification is the harness's job - this
        method performs no apply/verify/repair of its own.
        """
        judge_span = span_id or new_span_id()
        system = build_trajectory_step_system(trajectories, system=self._trajectory_step_system)
        conversation = [ChatMessage(role="system", content=system), *messages]
        response = await judge_client.chat(
            conversation,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        )
        terminal = not response.tool_calls
        _emit_judge(
            trace_id,
            judge_span,
            "judge.final" if terminal else "judge.thinking",
            payload={
                "fusion_unit": "trajectory_step",
                "terminal": terminal,
                "content_preview": response.content[:500],
                **({"final_output": response.content} if terminal else {}),
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": call.arguments}
                    for call in response.tool_calls
                ],
                "input_trajectory_ids": [trajectory.id for trajectory in trajectories],
                "usage": _usage_payload(response),
            },
        )
        return response

    async def synthesize(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient,
        judge_sampling: SamplingConfig,
        synthesis_sampling: SamplingConfig,
        analysis: FusionAnalysis | None = None,
        final_output_artifact_id: str | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> JudgeSynthesisResult:
        """Fuse several trajectories into one final response.

        The judge compares the trajectories (final answers, and where present
        reasoning, tool calls, observations, and verification results) and the
        synthesizer produces the final answer in the request's natural shape and
        first person. A plain sampled answer is a zero-step trajectory, so this
        one path serves both text fusion and agent-trajectory fusion.
        """
        if not trajectories:
            raise ValueError("at least one trajectory is required")
        judge_span = span_id or new_span_id()
        resolved_analysis = analysis or await self.analyze(
            messages,
            trajectories,
            judge_client=judge_client,
            judge_sampling=judge_sampling,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        metrics = _synthesis_metrics(
            trajectories,
            resolved_analysis,
            final_output_artifact_id=final_output_artifact_id,
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.scored",
            payload={
                "fusion_unit": "trajectory",
                "analysis": resolved_analysis.model_dump(mode="json"),
                "metrics": metrics,
                "input_ids": [trajectory.id for trajectory in trajectories],
            },
        )
        final_output = await self._synthesize_answer(
            messages,
            trajectories,
            resolved_analysis,
            synthesizer_client=synthesizer_client,
            synthesis_sampling=synthesis_sampling,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        if not final_output.strip():
            # The synthesizer returned nothing (e.g. a reasoning model exhausted
            # its token budget on reasoning). Fall back to the best trajectory's
            # own answer so a fused response is always produced.
            final_output = _best_trajectory_output(trajectories)
        selected_trajectory_id = _selected_trajectory_id(final_output, trajectories)
        synthesis_id = _synthesis_id()
        record = JudgeSynthesisRecordV1.model_validate(
            {
                **contract_metadata("judge-synthesis-record.v1"),
                "synthesis_id": synthesis_id,
                "input_trajectory_ids": [trajectory.id for trajectory in trajectories],
                "status": "succeeded",
                "decision": "select_trajectory" if selected_trajectory_id else "synthesize",
                "selected_trajectory_id": selected_trajectory_id,
                "rationale": _rationale(resolved_analysis),
                "final_output": final_output,
                "metrics": metrics,
            }
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.final",
            payload={
                "synthesis_id": synthesis_id,
                "decision": "select_trajectory" if selected_trajectory_id else "synthesize",
                "selected_trajectory_id": selected_trajectory_id,
                "rationale": _rationale(resolved_analysis),
                "final_output": final_output,
                "record": record.model_dump(mode="json"),
            },
        )
        return JudgeSynthesisResult(
            record=record,
            final_output=final_output,
            analysis=resolved_analysis,
            ranked_trajectories=list(trajectories),
        )

    async def analyze(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        judge_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
    ) -> FusionAnalysis:
        response = await judge_client.chat(
            [
                ChatMessage(role="system", content=self._judge_system),
                ChatMessage(
                    role="user",
                    content=build_judge_prompt(_last_user_text(messages), trajectories),
                ),
            ],
            judge_sampling,
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.thinking",
            payload={
                "fusion_unit": "trajectory",
                "raw_analysis": response.content,
                "usage": _usage_payload(response),
            },
        )
        return parse_analysis(response.content)

    async def _synthesize_answer(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        analysis: FusionAnalysis,
        *,
        synthesizer_client: ChatClient,
        synthesis_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
    ) -> str:
        response = await synthesizer_client.chat(
            [
                ChatMessage(role="system", content=self._synthesizer_system),
                ChatMessage(
                    role="user",
                    content=build_synthesis_prompt(
                        _last_user_text(messages), trajectories, analysis
                    ),
                ),
            ],
            synthesis_sampling,
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.synthesis",
            payload={
                "raw_output": response.content,
                "empty": not response.content.strip(),
                "usage": _usage_payload(response),
            },
        )
        return response.content


# Sentinel consensus written when the judge response is not valid JSON. Shared
# between the producer (parse_analysis) and the detector (_judge_parse_failed)
# so the two cannot silently drift apart.
_PARSE_FAILURE_CONSENSUS = "Judge did not return valid structured JSON."


def parse_analysis(content: str) -> FusionAnalysis:
    try:
        return FusionAnalysis.model_validate_json(_extract_json(content))
    except (ValueError, TypeError, json.JSONDecodeError):
        return FusionAnalysis(
            consensus=[_PARSE_FAILURE_CONSENSUS],
            likely_errors=[content[:500]],
        )


def _synthesis_metrics(
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
    *,
    final_output_artifact_id: str | None,
) -> dict[str, Any]:
    contributions = [
        {
            "trajectory_id": trajectory.id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "verification_status": (
                trajectory.verification.status if trajectory.verification is not None else None
            ),
            "step_count": len(trajectory.steps),
            "reason": "included as judge synthesis evidence",
        }
        for trajectory in trajectories
    ]
    rejections = [
        {"trajectory_id": _trajectory_id_for_reason(reason, trajectories), "reason": reason}
        for reason in analysis.likely_errors
    ]
    metrics: dict[str, Any] = {
        "trajectory_contributions": contributions,
        "trajectory_rejections": rejections,
        "judge_structured_parse_status": _judge_parse_status(analysis),
        "fusion_unit": "trajectory",
    }
    if _judge_parse_failed(analysis):
        metrics["judge_structured_parse_error"] = "invalid_json"
    if final_output_artifact_id is not None:
        metrics["final_output_artifact_id"] = final_output_artifact_id
    return metrics


def _best_trajectory_output(trajectories: Sequence[Trajectory]) -> str:
    """Pick a non-empty answer: prefer a verified trajectory, then any succeeded
    one, then the first with text."""

    def _rank(trajectory: Trajectory) -> tuple[int, int]:
        verification = trajectory.verification
        verified = verification is not None and verification.status == "succeeded"
        return (0 if verified else 1, 0 if trajectory.status == "succeeded" else 1)

    ordered = sorted(trajectories, key=_rank)
    for trajectory in ordered:
        if trajectory.content.strip():
            return trajectory.content.strip()
    return "No candidate produced a usable result."


def _selected_trajectory_id(final_output: str, trajectories: Sequence[Trajectory]) -> str | None:
    stripped = final_output.strip()
    for trajectory in trajectories:
        if stripped == trajectory.content.strip():
            return trajectory.id
    return None


def _trajectory_id_for_reason(reason: str, trajectories: Sequence[Trajectory]) -> str | None:
    lower_reason = reason.lower()
    for trajectory in trajectories:
        if trajectory.id.lower() in lower_reason or trajectory.model_id.lower() in lower_reason:
            return trajectory.id
    ordinal_words = ("one", "two", "three", "four", "five")
    for index, word in enumerate(ordinal_words):
        if index < len(trajectories) and f"candidate {word}" in lower_reason:
            return trajectories[index].id
    return None


def _rationale(analysis: FusionAnalysis) -> str:
    rationale_parts = [
        *analysis.consensus,
        *analysis.contradictions,
        *analysis.unique_insights,
        *analysis.coverage_gaps,
    ]
    return "; ".join(rationale_parts[:6])


def _judge_parse_status(analysis: FusionAnalysis) -> str:
    return "failed" if _judge_parse_failed(analysis) else "parsed"


def _judge_parse_failed(analysis: FusionAnalysis) -> bool:
    return analysis.consensus == [_PARSE_FAILURE_CONSENSUS]


def _synthesis_id() -> str:
    return f"synthesis_{uuid.uuid4().hex}"


def _last_user_text(messages: Sequence[ChatMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user":
            return message.content
    return ""


def _extract_json(content: str) -> str:
    stripped = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", stripped, flags=re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    return stripped


def _emit_judge(
    trace_id: str | None,
    span_id: str | None,
    event_type: str,
    *,
    payload: dict[str, Any],
) -> None:
    trace_emit(
        component="judge",
        event_type=event_type,
        trace_id=trace_id,
        span_id=span_id,
        payload=payload,
    )


def _usage_payload(response: Any) -> dict[str, Any]:
    usage = getattr(response, "usage", None)
    out: dict[str, Any] = {}
    if usage is not None:
        out = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None),
        }
    latency = getattr(response, "latency_s", None)
    if latency is not None:
        out["latency_s"] = latency
    model_id = getattr(response, "model_id", None)
    if model_id is not None:
        out["model_id"] = model_id
    return out


__all__ = [
    "JudgeSynthesisResult",
    "JudgeSynthesizer",
    "parse_analysis",
]
