from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.panel import PanelRunner
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    VERIFIER_SYSTEM_PROMPT,
    build_judge_prompt,
    build_synthesis_prompt,
    build_verifier_prompt,
)
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.types import Candidate, ChatMessage, FusionAnalysis, FusionResult


class CandidateRanker:
    def rank(self, candidates: Sequence[Candidate]) -> list[Candidate]:
        ranked = sorted(
            candidates,
            key=lambda candidate: (
                _candidate_signal(candidate),
                len(candidate.content),
            ),
            reverse=True,
        )
        return [
            candidate.model_copy(update={"rank": index + 1, "score": float(len(ranked) - index)})
            for index, candidate in enumerate(ranked)
        ]


class FusionEngine:
    def __init__(
        self,
        config: FusionConfig,
        clients: Mapping[str, ChatClient],
        router: HeuristicRouter | None = None,
    ) -> None:
        self.config = config
        self.clients = dict(clients)
        self.panel_runner = PanelRunner(self.clients)
        self.router = router or HeuristicRouter()
        self.ranker = CandidateRanker()

    async def run(
        self,
        messages: Sequence[ChatMessage],
        mode: FusionMode | None = None,
        sampling: SamplingConfig | None = None,
        panel_models: Sequence[str] | None = None,
        sample_count: int | None = None,
        verify: bool = False,
    ) -> FusionResult:
        selected_mode = mode or self.config.default_mode
        selected_sampling = sampling or self.config.sampling
        if selected_mode == "router":
            decision = self.router.route(messages)
            result = await self.run(
                messages,
                mode=decision.route,
                sampling=selected_sampling,
                panel_models=panel_models,
                sample_count=sample_count,
                verify=verify,
            )
            result.route = decision.route
            result.metrics["router_reasons"] = list(decision.reasons)
            return result
        if selected_mode == "single":
            candidate = await self.panel_runner.generate_single(
                self.config.default_model,
                messages,
                selected_sampling,
            )
            return FusionResult(
                mode="single",
                content=candidate.content,
                candidates=[candidate],
                metrics=_candidate_metrics([candidate]),
            )

        candidates = await self._generate_candidates(
            mode=selected_mode,
            messages=messages,
            sampling=selected_sampling,
            panel_models=panel_models,
            sample_count=sample_count,
        )
        ranked = self.ranker.rank(candidates)
        analysis = await self._analyze(messages, ranked)
        answer = await self._synthesize(messages, ranked, analysis)
        if verify:
            answer = await self._verify(messages, answer, ranked)
        return FusionResult(
            mode=selected_mode,
            content=answer,
            candidates=ranked,
            analysis=analysis,
            metrics=_candidate_metrics(ranked),
        )

    async def _generate_candidates(
        self,
        mode: FusionMode,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        panel_models: Sequence[str] | None,
        sample_count: int | None,
    ) -> list[Candidate]:
        if mode == "self":
            return await self.panel_runner.generate_self_fusion(
                self.config.default_model,
                messages,
                sampling,
                self.config.self_temperatures,
                sample_count or self.config.sample_count,
            )
        if mode == "panel":
            models = list(panel_models or self.config.panel_models)
            if not models:
                models = [endpoint.id for endpoint in self.config.endpoints]
            return await self.panel_runner.generate_panel(models, messages, sampling)
        raise ValueError(f"Unsupported fusion generation mode: {mode}")

    async def _analyze(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
    ) -> FusionAnalysis:
        judge = self._client(self.config.resolved_judge_model)
        response = await judge.chat(
            [
                ChatMessage(role="system", content=JUDGE_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_judge_prompt(_last_user_text(messages), candidates),
                ),
            ],
            self.config.sampling.model_copy(update={"temperature": 0.0}),
        )
        return _parse_analysis(response.content)

    async def _synthesize(
        self,
        messages: Sequence[ChatMessage],
        candidates: Sequence[Candidate],
        analysis: FusionAnalysis,
    ) -> str:
        synthesizer = self._client(self.config.resolved_synthesizer_model)
        response = await synthesizer.chat(
            [
                ChatMessage(role="system", content=SYNTHESIZER_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_synthesis_prompt(_last_user_text(messages), candidates, analysis),
                ),
            ],
            self.config.sampling,
        )
        return response.content

    async def _verify(
        self,
        messages: Sequence[ChatMessage],
        answer: str,
        candidates: Sequence[Candidate],
    ) -> str:
        verifier = self._client(self.config.resolved_judge_model)
        response = await verifier.chat(
            [
                ChatMessage(role="system", content=VERIFIER_SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=build_verifier_prompt(_last_user_text(messages), answer, candidates),
                ),
            ],
            self.config.sampling.model_copy(update={"temperature": 0.0}),
        )
        return response.content

    def _client(self, model_id: str) -> ChatClient:
        try:
            return self.clients[model_id]
        except KeyError as exc:
            raise KeyError(f"No client configured for model: {model_id}") from exc


def normalize_messages(messages: Sequence[ChatMessage | Mapping[str, str]]) -> list[ChatMessage]:
    normalized = []
    for message in messages:
        if isinstance(message, ChatMessage):
            normalized.append(message)
        else:
            normalized.append(ChatMessage.model_validate(message))
    return normalized


def _last_user_text(messages: Sequence[ChatMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user":
            return message.content
    return ""


def _candidate_signal(candidate: Candidate) -> int:
    lower = candidate.content.lower()
    signal_words = ("because", "therefore", "however", "evidence", "tradeoff", "verify")
    return sum(1 for word in signal_words if word in lower)


def _candidate_metrics(candidates: Sequence[Candidate]) -> dict[str, object]:
    latencies = [
        latency
        for candidate in candidates
        if isinstance(latency := candidate.metadata.get("latency_s"), int | float)
    ]
    completion_tokens = 0
    prompt_tokens = 0
    for candidate in candidates:
        usage = candidate.metadata.get("usage")
        if not isinstance(usage, dict):
            continue
        completion_tokens += _optional_int(usage.get("completion_tokens"))
        prompt_tokens += _optional_int(usage.get("prompt_tokens"))
    return {
        "candidate_count": len(candidates),
        "candidate_model_ids": [candidate.model_id for candidate in candidates],
        "candidate_latency_s_max": max(latencies, default=0.0),
        "candidate_latency_s_sum": sum(latencies),
        "candidate_prompt_tokens": prompt_tokens,
        "candidate_completion_tokens": completion_tokens,
    }


def _optional_int(value: object) -> int:
    if isinstance(value, int):
        return value
    return 0


def _parse_analysis(content: str) -> FusionAnalysis:
    try:
        return FusionAnalysis.model_validate_json(_extract_json(content))
    except (ValueError, TypeError, json.JSONDecodeError):
        return FusionAnalysis(
            consensus=["Judge did not return valid structured JSON."],
            likely_errors=[content[:500]],
        )


def _extract_json(content: str) -> str:
    stripped = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", stripped, flags=re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    return stripped
