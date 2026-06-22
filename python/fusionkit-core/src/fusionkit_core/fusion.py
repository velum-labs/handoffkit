from __future__ import annotations

from collections.abc import Mapping, Sequence

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.judge import JudgeSynthesisResult, JudgeSynthesizer
from fusionkit_core.producers import ChatTrajectoryProducer
from fusionkit_core.prompts import (
    VERIFIER_SYSTEM_PROMPT,
    build_verifier_prompt,
)
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.types import ChatMessage, FusionResult, Trajectory


class TrajectoryRanker:
    """Heuristic pre-ranker over trajectories.

    Ranks by verification status first (a passed verification dominates), then by
    a cheap reasoning-signal/length heuristic on the final output. This only
    orders the evidence handed to the judge; it never picks the winner.
    """

    def rank(self, trajectories: Sequence[Trajectory]) -> list[Trajectory]:
        ranked = sorted(
            trajectories,
            key=lambda trajectory: (
                _verification_rank(trajectory),
                _trajectory_signal(trajectory),
                len(trajectory.content),
            ),
            reverse=True,
        )
        return [
            trajectory.model_copy(update={"rank": index + 1, "score": float(len(ranked) - index)})
            for index, trajectory in enumerate(ranked)
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
        self.producer = ChatTrajectoryProducer(self.clients)
        self.router = router or HeuristicRouter()
        self.ranker = TrajectoryRanker()
        self.judge_synthesizer = JudgeSynthesizer(config.prompts)

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
            trajectory = await self.producer.generate_single(
                self.config.default_model,
                messages,
                selected_sampling,
            )
            return FusionResult(
                mode="single",
                content=trajectory.content,
                trajectories=[trajectory],
                metrics=_trajectory_metrics([trajectory]),
            )

        trajectories = await self._generate_trajectories(
            mode=selected_mode,
            messages=messages,
            sampling=selected_sampling,
            panel_models=panel_models,
            sample_count=sample_count,
        )
        ranked = self.ranker.rank(trajectories)
        synthesis = await self._judge_synthesize(messages, ranked)
        answer = synthesis.final_output
        repair_metadata: dict[str, object] = {"repair_attempted": False, "repair_rounds": 0}
        if verify:
            answer = await self._verify(messages, answer, ranked)
            repair_metadata = {
                "repair_attempted": True,
                "repair_rounds": 1,
                "repair_reason": "verify_requested",
            }
            synthesis = _with_repair_metadata(synthesis, repair_metadata, answer)
        return FusionResult(
            mode=selected_mode,
            content=answer,
            trajectories=ranked,
            analysis=synthesis.analysis,
            metrics={
                **_trajectory_metrics(ranked),
                "judge_synthesis_id": synthesis.record.synthesis_id,
                "judge_synthesis_record": synthesis.record.model_dump(mode="json"),
                **repair_metadata,
            },
        )

    async def _generate_trajectories(
        self,
        mode: FusionMode,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        panel_models: Sequence[str] | None,
        sample_count: int | None,
    ) -> list[Trajectory]:
        if mode == "self":
            return await self.producer.generate_self_fusion(
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
            return await self.producer.generate_panel(models, messages, sampling)
        raise ValueError(f"Unsupported fusion generation mode: {mode}")

    async def _judge_synthesize(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
    ) -> JudgeSynthesisResult:
        judge = self._client(self.config.resolved_judge_model)
        synthesizer = self._client(self.config.resolved_synthesizer_model)
        return await self.judge_synthesizer.synthesize(
            messages,
            trajectories,
            judge_client=judge,
            synthesizer_client=synthesizer,
            judge_sampling=self.config.sampling.model_copy(update={"temperature": 0.0}),
            synthesis_sampling=self.config.sampling,
        )

    async def _verify(
        self,
        messages: Sequence[ChatMessage],
        answer: str,
        trajectories: Sequence[Trajectory],
    ) -> str:
        verifier = self._client(self.config.resolved_judge_model)
        response = await verifier.chat(
            [
                ChatMessage(
                    role="system",
                    content=self.config.prompts.verifier_system or VERIFIER_SYSTEM_PROMPT,
                ),
                ChatMessage(
                    role="user",
                    content=build_verifier_prompt(_last_user_text(messages), answer, trajectories),
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


def _verification_rank(trajectory: Trajectory) -> int:
    verification = trajectory.verification
    if verification is None:
        return 0
    if verification.status == "succeeded":
        return 2
    return -1


def _trajectory_signal(trajectory: Trajectory) -> int:
    lower = trajectory.content.lower()
    signal_words = ("because", "therefore", "however", "evidence", "tradeoff", "verify")
    return sum(1 for word in signal_words if word in lower)


def _trajectory_metrics(trajectories: Sequence[Trajectory]) -> dict[str, object]:
    latencies = [
        latency
        for trajectory in trajectories
        if isinstance(latency := trajectory.metadata.get("latency_s"), int | float)
    ]
    completion_tokens = 0
    prompt_tokens = 0
    for trajectory in trajectories:
        usage = trajectory.metadata.get("usage")
        if not isinstance(usage, dict):
            continue
        completion_tokens += _optional_int(usage.get("completion_tokens"))
        prompt_tokens += _optional_int(usage.get("prompt_tokens"))
    return {
        "trajectory_count": len(trajectories),
        "trajectory_model_ids": [trajectory.model_id for trajectory in trajectories],
        "trajectory_latency_s_max": max(latencies, default=0.0),
        "trajectory_latency_s_sum": sum(latencies),
        "trajectory_prompt_tokens": prompt_tokens,
        "trajectory_completion_tokens": completion_tokens,
    }


def _optional_int(value: object) -> int:
    if isinstance(value, int):
        return value
    return 0


def _with_repair_metadata(
    synthesis: JudgeSynthesisResult,
    repair_metadata: dict[str, object],
    answer: str,
) -> JudgeSynthesisResult:
    record = synthesis.record.model_copy(
        update={
            "final_output": answer,
            "metrics": {
                **(synthesis.record.metrics or {}),
                **repair_metadata,
            },
        }
    )
    return synthesis.model_copy(update={"record": record, "final_output": answer})
