from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import PromptOverrides, SamplingConfig
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    build_fuse_system,
    build_judge_prompt,
)
from fusionkit_core.trace import emit as trace_emit
from fusionkit_core.trace import new_span_id
from fusionkit_core.types import (
    ChatMessage,
    FusionAnalysis,
    ModelResponse,
    StreamChunk,
    ToolCall,
    Trajectory,
    TrajectorySynthesis,
    Usage,
)


class FuseResult(BaseModel):
    """The result of one :meth:`JudgeSynthesizer.fuse` step.

    ``response`` is the synthesizer's model turn (content + any tool calls).
    ``terminal`` is true when the step produced the final answer (no tool calls);
    only then is ``trajectory`` set - the consolidated output trajectory whose
    ``synthesis`` metadata carries the fusion decision/rationale/metrics.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    response: ModelResponse
    terminal: bool
    analysis: FusionAnalysis
    trajectory: Trajectory | None = None


class JudgeSynthesizer:
    def __init__(self, prompts: PromptOverrides | None = None) -> None:
        overrides = prompts or PromptOverrides()
        self._judge_system = overrides.judge_system or JUDGE_SYSTEM_PROMPT
        self._synthesizer_system = overrides.synthesizer_system or SYNTHESIZER_SYSTEM_PROMPT

    async def fuse(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient | None = None,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        analysis: FusionAnalysis | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> FuseResult:
        """One fusion step: produce the next step, or the final answer.

        This is the single fusion operation. With ``tools=None`` the synthesizer
        is necessarily terminal on its first turn - the old one-shot text fusion,
        where "produce an answer" is just a zero-tool-round trajectory. With tools
        present it may emit tool calls and the harness drives the loop, calling
        back with the observed results.

        The judge ``analyze`` runs once; pass ``analysis`` to reuse a cached result
        across a turn's tool loop (avoids re-analyzing the unchanged candidates).
        On a terminal step the consolidated output :class:`Trajectory` is built and
        its ``synthesis`` is populated (decision/selected/rationale/metrics) - the
        fusion result lives on the trajectory, not in a separate record.
        """
        synth_client = synthesizer_client or judge_client
        judge_span = span_id or new_span_id()
        conversation, resolved_analysis = await self._prepare_conversation(
            messages,
            trajectories,
            judge_client=judge_client,
            sampling=sampling,
            tools=tools,
            analysis=analysis,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        response = await synth_client.chat(
            conversation,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        )
        result = self._build_fuse_result(response, trajectories, resolved_analysis)
        self._emit_step(
            trace_id, judge_span, result.response, result.terminal, result.trajectory, trajectories
        )
        return result

    async def fuse_stream(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient | None = None,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        analysis: FusionAnalysis | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        """Streaming counterpart of :meth:`fuse`: the synthesizer turn streams.

        Yields the synthesizer's :class:`StreamChunk`s as real tokens arrive
        (true streaming, not buffer-then-rechunk), then a final
        :class:`FuseResult` as the last item so the caller can attach the fused
        trajectory metadata to the terminal SSE chunk. The judge ``analyze`` is
        still a single up-front non-streaming call.
        """
        synth_client = synthesizer_client or judge_client
        judge_span = span_id or new_span_id()
        conversation, resolved_analysis = await self._prepare_conversation(
            messages,
            trajectories,
            judge_client=judge_client,
            sampling=sampling,
            tools=tools,
            analysis=analysis,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        content_parts: list[str] = []
        tool_accumulator: list[dict[str, str]] = []
        seen_tool_ids: set[str] = set()
        finish_reason: str | None = None
        usage = Usage()
        async for chunk in synth_client.stream_chat(
            conversation,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        ):
            if chunk.delta:
                content_parts.append(chunk.delta)
            if chunk.tool_call_delta is not None:
                accumulate_tool_call(tool_accumulator, seen_tool_ids, chunk.tool_call_delta)
            if chunk.finish_reason is not None:
                finish_reason = chunk.finish_reason
            if chunk.usage is not None:
                usage = chunk.usage
            yield chunk
        tool_calls = [
            ToolCall(id=item["id"], name=item["name"], arguments=item["arguments"] or "{}")
            for item in tool_accumulator
        ]
        response = ModelResponse(
            model_id=synth_client.model_id,
            content="".join(content_parts),
            finish_reason=finish_reason or ("tool_calls" if tool_calls else "stop"),
            usage=usage,
            tool_calls=tool_calls,
        )
        result = self._build_fuse_result(response, trajectories, resolved_analysis)
        self._emit_step(
            trace_id, judge_span, result.response, result.terminal, result.trajectory, trajectories
        )
        yield result

    async def _prepare_conversation(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None,
        analysis: FusionAnalysis | None,
        trace_id: str | None,
        judge_span: str | None,
    ) -> tuple[list[ChatMessage], FusionAnalysis]:
        """Build the synthesizer conversation (judge analysis + system + history).

        Shared by :meth:`fuse` and :meth:`fuse_stream` so the streaming and
        non-streaming paths cannot drift in how they ground the synthesizer.
        """
        resolved_analysis = analysis
        if resolved_analysis is None and trajectories:
            resolved_analysis = await self.analyze(
                messages,
                trajectories,
                judge_client=judge_client,
                judge_sampling=sampling.model_copy(update={"temperature": 0.0}),
                trace_id=trace_id,
                judge_span=judge_span,
            )
        if resolved_analysis is None:
            resolved_analysis = FusionAnalysis()
        system = build_fuse_system(
            trajectories,
            synthesizer_system=self._synthesizer_system,
            analysis=resolved_analysis if trajectories else None,
            tools_present=tools is not None,
        )
        conversation = [ChatMessage(role="system", content=system), *messages]
        return conversation, resolved_analysis

    def _build_fuse_result(
        self,
        response: ModelResponse,
        trajectories: Sequence[Trajectory],
        resolved_analysis: FusionAnalysis,
    ) -> FuseResult:
        terminal = not response.tool_calls
        output_trajectory: Trajectory | None = None
        if terminal:
            final_output = response.content
            if not final_output.strip() and trajectories:
                # The synthesizer returned nothing (e.g. a reasoning model spent
                # its budget on reasoning). Fall back to the best trajectory's own
                # answer so a fused response is always produced.
                final_output = _best_trajectory_output(trajectories)
                response = response.model_copy(update={"content": final_output})
            output_trajectory = _consolidated_trajectory(
                final_output, trajectories, resolved_analysis
            )
        return FuseResult(
            response=response,
            terminal=terminal,
            analysis=resolved_analysis,
            trajectory=output_trajectory,
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

    def _emit_step(
        self,
        trace_id: str | None,
        judge_span: str | None,
        response: ModelResponse,
        terminal: bool,
        output_trajectory: Trajectory | None,
        trajectories: Sequence[Trajectory],
    ) -> None:
        payload: dict[str, Any] = {
            "fusion_unit": "trajectory_step",
            "terminal": terminal,
            "content_preview": response.content[:500],
            "tool_calls": [
                {"id": call.id, "name": call.name, "arguments": call.arguments}
                for call in response.tool_calls
            ],
            "input_trajectory_ids": [trajectory.id for trajectory in trajectories],
            "usage": _usage_payload(response),
        }
        if terminal and output_trajectory is not None:
            synthesis = output_trajectory.synthesis
            payload["final_output"] = response.content
            if synthesis is not None:
                payload["decision"] = synthesis.decision
                payload["selected_trajectory_id"] = synthesis.selected_trajectory_id
                payload["rationale"] = synthesis.rationale
                payload["synthesis"] = synthesis.model_dump(mode="json")
        _emit_judge(
            trace_id,
            judge_span,
            "judge.final" if terminal else "judge.thinking",
            payload=payload,
        )


# Sentinel consensus written when the judge response is not valid JSON. Shared
# between the producer (parse_analysis) and the detector (_judge_parse_failed)
# so the two cannot silently drift apart.
_PARSE_FAILURE_CONSENSUS = "Judge did not return valid structured JSON."


def accumulate_tool_call(
    accumulator: list[dict[str, str]],
    seen_ids: set[str],
    delta: ToolCall,
) -> None:
    """Fold a streamed tool-call fragment into the in-progress accumulator.

    Handles both common streaming shapes: OpenAI Chat (the opening fragment
    carries id+name, later fragments carry argument text with an empty id) and
    Codex/Responses (every argument fragment repeats the same non-empty
    ``call_id``). A new, previously unseen id starts a fresh call; anything else
    appends argument text (and a late name) to the call already in flight.
    """
    if delta.id and delta.id not in seen_ids:
        seen_ids.add(delta.id)
        accumulator.append({"id": delta.id, "name": delta.name, "arguments": delta.arguments})
        return
    if not accumulator:
        accumulator.append({"id": delta.id, "name": delta.name, "arguments": delta.arguments})
        return
    current = accumulator[-1]
    if delta.name:
        current["name"] = delta.name
    current["arguments"] += delta.arguments


def parse_analysis(content: str) -> FusionAnalysis:
    try:
        return FusionAnalysis.model_validate_json(_extract_json(content))
    except (ValueError, TypeError, json.JSONDecodeError):
        return FusionAnalysis(
            consensus=[_PARSE_FAILURE_CONSENSUS],
            likely_errors=[content[:500]],
        )


def _consolidated_trajectory(
    final_output: str,
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
) -> Trajectory:
    """Build the fused output trajectory with its ``synthesis`` metadata."""
    selected_trajectory_id = _selected_trajectory_id(final_output, trajectories)
    synthesis = TrajectorySynthesis(
        decision="select_trajectory" if selected_trajectory_id else "synthesize",
        selected_trajectory_id=selected_trajectory_id,
        rationale=_rationale(analysis),
        input_trajectory_ids=[trajectory.id for trajectory in trajectories],
        metrics=_synthesis_metrics(trajectories, analysis),
    )
    return Trajectory(
        id=_synthesis_id(),
        model_id="fusionkit/synthesizer",
        content=final_output,
        items=[],
        status="succeeded",
        synthesis=synthesis,
    )


def _synthesis_metrics(
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
    *,
    final_output_artifact_id: str | None = None,
) -> dict[str, Any]:
    contributions = [
        {
            "trajectory_id": trajectory.id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "item_count": len(trajectory.items),
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
    """Pick a non-empty answer: prefer a succeeded trajectory, then any with text."""

    def _rank(trajectory: Trajectory) -> int:
        return 0 if trajectory.status == "succeeded" else 1

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
    "FuseResult",
    "JudgeSynthesizer",
    "accumulate_tool_call",
    "parse_analysis",
]
