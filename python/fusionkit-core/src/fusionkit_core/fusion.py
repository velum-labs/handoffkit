from __future__ import annotations

from collections.abc import Mapping, Sequence

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.judge import FuseResult, JudgeSynthesizer
from fusionkit_core.producers import ChatTrajectoryProducer
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.types import ChatMessage, FusionResult, Trajectory


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
        self.judge_synthesizer = JudgeSynthesizer(config.prompts)

    async def run(
        self,
        messages: Sequence[ChatMessage],
        mode: FusionMode | None = None,
        sampling: SamplingConfig | None = None,
        panel_models: Sequence[str] | None = None,
        sample_count: int | None = None,
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
        fused = await self._judge_synthesize(messages, trajectories)
        answer = fused.response.content
        metrics: dict[str, object] = {**_trajectory_metrics(trajectories)}
        synthesis = fused.trajectory.synthesis if fused.trajectory is not None else None
        if synthesis is not None:
            metrics["synthesis"] = synthesis.model_dump(mode="json")
        return FusionResult(
            mode=selected_mode,
            content=answer,
            trajectories=trajectories,
            analysis=fused.analysis,
            metrics=metrics,
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
    ) -> FuseResult:
        judge = self._client(self.config.resolved_judge_model)
        synthesizer = self._client(self.config.resolved_synthesizer_model)
        survivors = [t for t in trajectories if t.status == "succeeded"] or list(trajectories)
        # Text fusion is a zero-tool-round fuse: no tools means the synthesizer is
        # terminal on turn 1 and the fused answer + synthesis come back at once.
        return await self.judge_synthesizer.fuse(
            messages,
            survivors,
            judge_client=judge,
            synthesizer_client=synthesizer,
            sampling=self.config.sampling,
            tools=None,
        )

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
    succeeded_count = sum(1 for trajectory in trajectories if trajectory.status == "succeeded")
    return {
        "trajectory_count": len(trajectories),
        "succeeded_trajectory_count": succeeded_count,
        "failed_trajectory_count": len(trajectories) - succeeded_count,
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
