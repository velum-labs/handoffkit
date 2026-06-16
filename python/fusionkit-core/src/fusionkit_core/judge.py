from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import JudgeSynthesisRecordV1, contract_metadata
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    build_judge_prompt,
    build_synthesis_prompt,
)
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


class JudgeSynthesizer:
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
    ) -> JudgeSynthesisResult:
        resolved_analysis = analysis or await self.analyze(
            messages,
            candidates,
            judge_client=judge_client,
            judge_sampling=judge_sampling,
        )
        final_output = await self._synthesize_answer(
            messages,
            candidates,
            resolved_analysis,
            synthesizer_client=synthesizer_client,
            synthesis_sampling=synthesis_sampling,
        )
        evidence = [candidate_evidence(candidate) for candidate in candidates]
        metrics = _synthesis_metrics(
            candidates,
            resolved_analysis,
            final_output_artifact_id=final_output_artifact_id,
            repair_metadata=repair_metadata,
        )
        selected_candidate_id = _selected_candidate_id(final_output, candidates)
        record = JudgeSynthesisRecordV1.model_validate(
            {
                **contract_metadata("judge-synthesis-record.v1"),
                "synthesis_id": _synthesis_id(),
                "input_candidate_ids": [candidate.id for candidate in candidates],
                "status": "succeeded",
                "decision": "select_candidate" if selected_candidate_id else "synthesize",
                "selected_candidate_id": selected_candidate_id,
                "rationale": _rationale(resolved_analysis),
                "final_output": final_output,
                "metrics": metrics,
            }
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
        return parse_analysis(response.content)

    async def _synthesize_answer(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
        analysis: FusionAnalysis,
        *,
        synthesizer_client: ChatClient,
        synthesis_sampling: SamplingConfig,
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


__all__ = [
    "CandidateEvidence",
    "JudgeSynthesisResult",
    "JudgeSynthesizer",
    "candidate_evidence",
    "parse_analysis",
]
