from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import (
    HarnessTrajectoryV1,
    JudgeSynthesisRecordV1,
    contract_metadata,
)
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    TRAJECTORY_SYNTHESIZER_SYSTEM_PROMPT,
    build_judge_prompt,
    build_synthesis_prompt,
    build_trajectory_judge_prompt,
    build_trajectory_synthesis_prompt,
)
from fusionkit_core.trace import emit as trace_emit
from fusionkit_core.trace import new_span_id
from fusionkit_core.types import Candidate, ChatMessage, FusionAnalysis


class CandidateEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str
    model_id: str
    content: str
    rank: int | None = None
    score: float | None = None
    artifact_id: str | None = None


class JudgeSynthesisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record: JudgeSynthesisRecordV1
    final_output: str
    analysis: FusionAnalysis
    candidate_evidence: list[CandidateEvidence]
    ranked_candidates: list[Candidate]


class TrajectorySynthesisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record: JudgeSynthesisRecordV1
    final_output: str
    analysis: FusionAnalysis


class JudgeSynthesizer:
    async def synthesize_trajectories(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[HarnessTrajectoryV1],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient,
        judge_sampling: SamplingConfig,
        synthesis_sampling: SamplingConfig,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> TrajectorySynthesisResult:
        """Fuse several agent trajectories into one final response.

        Trajectory-level fusion: the judge compares the trajectories (reasoning,
        tool calls, observations, results) and the synthesizer produces the final
        answer in the request's natural shape and first person.
        """
        if not trajectories:
            raise ValueError("at least one trajectory is required")
        judge_span = span_id or new_span_id()
        user_request = _last_user_text(messages)
        analysis = await self._analyze_trajectories(
            user_request,
            trajectories,
            judge_client=judge_client,
            judge_sampling=judge_sampling,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        metrics = _trajectory_metrics(trajectories, analysis)
        _emit_judge(
            trace_id,
            judge_span,
            "judge.scored",
            payload={
                "fusion_unit": "trajectory",
                "analysis": analysis.model_dump(mode="json"),
                "metrics": metrics,
                "input_ids": [trajectory.trajectory_id for trajectory in trajectories],
            },
        )
        synthesis_response = await synthesizer_client.chat(
            [
                ChatMessage(role="system", content=TRAJECTORY_SYNTHESIZER_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_trajectory_synthesis_prompt(user_request, trajectories, analysis),
                ),
            ],
            synthesis_sampling,
        )
        final_output = synthesis_response.content.strip()
        _emit_judge(
            trace_id,
            judge_span,
            "judge.synthesis",
            payload={
                "raw_output": synthesis_response.content,
                "empty": not final_output,
                "usage": _usage_payload(synthesis_response),
            },
        )
        if not final_output:
            # The synthesizer returned nothing (e.g. a reasoning model exhausted
            # its token budget on reasoning). Fall back to the best trajectory's
            # own answer so a fused response is always produced.
            final_output = _best_trajectory_output(trajectories)
        synthesis_id = _synthesis_id()
        record = JudgeSynthesisRecordV1.model_validate(
            {
                **contract_metadata("judge-synthesis-record.v1"),
                "synthesis_id": synthesis_id,
                "input_candidate_ids": [trajectory.trajectory_id for trajectory in trajectories],
                "status": "succeeded",
                "decision": "synthesize",
                "rationale": _rationale(analysis),
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
                "decision": "synthesize",
                "rationale": _rationale(analysis),
                "final_output": final_output,
                "record": record.model_dump(mode="json"),
            },
        )
        return TrajectorySynthesisResult(record=record, final_output=final_output, analysis=analysis)

    async def _analyze_trajectories(
        self,
        user_request: str,
        trajectories: Sequence[HarnessTrajectoryV1],
        *,
        judge_client: ChatClient,
        judge_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
    ) -> FusionAnalysis:
        response = await judge_client.chat(
            [
                ChatMessage(role="system", content=JUDGE_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_trajectory_judge_prompt(user_request, trajectories),
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

    async def synthesize(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient,
        judge_sampling: SamplingConfig,
        synthesis_sampling: SamplingConfig,
        analysis: FusionAnalysis | None = None,
        final_output_artifact_id: str | None = None,
        repair_metadata: dict[str, Any] | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> JudgeSynthesisResult:
        judge_span = span_id or new_span_id()
        resolved_analysis = analysis or await self.analyze(
            messages,
            candidates,
            judge_client=judge_client,
            judge_sampling=judge_sampling,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        metrics = _synthesis_metrics(
            candidates,
            resolved_analysis,
            final_output_artifact_id=final_output_artifact_id,
            repair_metadata=repair_metadata,
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.scored",
            payload={
                "fusion_unit": "candidate",
                "analysis": resolved_analysis.model_dump(mode="json"),
                "metrics": metrics,
                "input_ids": [candidate.id for candidate in candidates],
            },
        )
        final_output = await self._synthesize_answer(
            messages,
            candidates,
            resolved_analysis,
            synthesizer_client=synthesizer_client,
            synthesis_sampling=synthesis_sampling,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        evidence = [candidate_evidence(candidate) for candidate in candidates]
        selected_candidate_id = _selected_candidate_id(final_output, candidates)
        synthesis_id = _synthesis_id()
        record = JudgeSynthesisRecordV1.model_validate(
            {
                **contract_metadata("judge-synthesis-record.v1"),
                "synthesis_id": synthesis_id,
                "input_candidate_ids": [candidate.id for candidate in candidates],
                "status": "succeeded",
                "decision": "select_candidate" if selected_candidate_id else "synthesize",
                "selected_candidate_id": selected_candidate_id,
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
                "decision": "select_candidate" if selected_candidate_id else "synthesize",
                "selected_candidate_id": selected_candidate_id,
                "rationale": _rationale(resolved_analysis),
                "final_output": final_output,
                "record": record.model_dump(mode="json"),
            },
        )
        return JudgeSynthesisResult(
            record=record,
            final_output=final_output,
            analysis=resolved_analysis,
            candidate_evidence=evidence,
            ranked_candidates=list(candidates),
        )

    async def analyze(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
        *,
        judge_client: ChatClient,
        judge_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
    ) -> FusionAnalysis:
        response = await judge_client.chat(
            [
                ChatMessage(role="system", content=JUDGE_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_judge_prompt(_last_user_text(messages), candidates),
                ),
            ],
            judge_sampling,
        )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.thinking",
            payload={
                "fusion_unit": "candidate",
                "raw_analysis": response.content,
                "usage": _usage_payload(response),
            },
        )
        return parse_analysis(response.content)

    async def _synthesize_answer(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
        analysis: FusionAnalysis,
        *,
        synthesizer_client: ChatClient,
        synthesis_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
    ) -> str:
        response = await synthesizer_client.chat(
            [
                ChatMessage(role="system", content=SYNTHESIZER_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_synthesis_prompt(_last_user_text(messages), candidates, analysis),
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


def candidate_evidence(candidate: Candidate, artifact_id: str | None = None) -> CandidateEvidence:
    return CandidateEvidence(
        candidate_id=candidate.id,
        model_id=candidate.model_id,
        content=candidate.content,
        rank=candidate.rank,
        score=candidate.score,
        artifact_id=artifact_id,
    )


def parse_analysis(content: str) -> FusionAnalysis:
    try:
        return FusionAnalysis.model_validate_json(_extract_json(content))
    except (ValueError, TypeError, json.JSONDecodeError):
        return FusionAnalysis(
            consensus=["Judge did not return valid structured JSON."],
            likely_errors=[content[:500]],
        )


def _synthesis_metrics(
    candidates: Sequence[Candidate],
    analysis: FusionAnalysis,
    *,
    final_output_artifact_id: str | None,
    repair_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    contributions = [
        {
            "candidate_id": candidate.id,
            "model_id": candidate.model_id,
            "rank": candidate.rank,
            "score": candidate.score,
            "reason": "included as judge synthesis evidence",
        }
        for candidate in candidates
    ]
    rejections = [
        {"candidate_id": _candidate_id_for_reason(reason, candidates), "reason": reason}
        for reason in analysis.likely_errors
    ]
    metrics: dict[str, Any] = {
        "candidate_contributions": contributions,
        "candidate_rejections": rejections,
        "candidate_ranks": [
            {"candidate_id": candidate.id, "rank": candidate.rank, "score": candidate.score}
            for candidate in candidates
        ],
        "judge_structured_parse_status": _judge_parse_status(analysis),
    }
    if _judge_parse_failed(analysis):
        metrics["judge_structured_parse_error"] = "invalid_json"
    if final_output_artifact_id is not None:
        metrics["final_output_artifact_id"] = final_output_artifact_id
    if repair_metadata is not None:
        metrics.update(repair_metadata)
    return metrics


def _best_trajectory_output(trajectories: Sequence[HarnessTrajectoryV1]) -> str:
    """Pick a non-empty answer: prefer a verified trajectory, then any succeeded
    one, then the first with text."""
    ordered = sorted(
        trajectories,
        key=lambda trajectory: (
            0 if (trajectory.verification is not None and trajectory.verification.status == "succeeded") else 1,
            0 if trajectory.status == "succeeded" else 1,
        ),
    )
    for trajectory in ordered:
        if trajectory.final_output.strip():
            return trajectory.final_output.strip()
    return "No candidate produced a usable result."


def _trajectory_metrics(
    trajectories: Sequence[HarnessTrajectoryV1],
    analysis: FusionAnalysis,
) -> dict[str, Any]:
    contributions = [
        {
            "trajectory_id": trajectory.trajectory_id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "verification_status": (
                trajectory.verification.status if trajectory.verification is not None else None
            ),
            "step_count": len(trajectory.steps),
            "reason": "included as trajectory fusion evidence",
        }
        for trajectory in trajectories
    ]
    return {
        "trajectory_contributions": contributions,
        "judge_structured_parse_status": _judge_parse_status(analysis),
        "fusion_unit": "trajectory",
    }


def _selected_candidate_id(final_output: str, candidates: Sequence[Candidate]) -> str | None:
    stripped = final_output.strip()
    for candidate in candidates:
        if stripped == candidate.content.strip():
            return candidate.id
    return None


def _candidate_id_for_reason(reason: str, candidates: Sequence[Candidate]) -> str | None:
    lower_reason = reason.lower()
    for candidate in candidates:
        if candidate.id.lower() in lower_reason or candidate.model_id.lower() in lower_reason:
            return candidate.id
    ordinal_words = ("one", "two", "three", "four", "five")
    for index, word in enumerate(ordinal_words):
        if index < len(candidates) and f"candidate {word}" in lower_reason:
            return candidates[index].id
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
    return analysis.consensus == ["Judge did not return valid structured JSON."]


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
    "CandidateEvidence",
    "JudgeSynthesisResult",
    "JudgeSynthesizer",
    "TrajectorySynthesisResult",
    "candidate_evidence",
    "parse_analysis",
]
