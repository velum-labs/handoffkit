from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence

from fusionkit_core.clients import ChatClient, ToolChoice, ToolDefinition
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.judge import FuseResult, JudgeSynthesizer, accumulate_tool_call
from fusionkit_core.producers import ChatTrajectoryProducer
from fusionkit_core.router import HeuristicRouter
from fusionkit_core.types import (
    ChatMessage,
    FusionAnalysis,
    FusionResult,
    ModelResponse,
    StreamChunk,
    ToolCall,
    Trajectory,
    Usage,
)


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
        self.judge_synthesizer = JudgeSynthesizer(
            config.prompts,
            harness_passthrough=config.harness_prompt_passthrough,
            select_best=config.synthesis_select_best,
        )

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
        tools: Sequence[ToolDefinition] | None = None,
    ) -> list[Trajectory]:
        if mode == "self":
            return await self.producer.generate_self_fusion(
                self.config.default_model,
                messages,
                sampling,
                self.config.self_temperatures,
                sample_count or self.config.sample_count,
                tools=tools,
            )
        if mode == "panel":
            models = list(panel_models or self.config.panel_models)
            if not models:
                models = [endpoint.id for endpoint in self.config.endpoints]
            return await self.producer.generate_panel(models, messages, sampling, tools=tools)
        raise ValueError(f"Unsupported fusion generation mode: {mode}")

    async def run_step(
        self,
        messages: Sequence[ChatMessage],
        *,
        mode: FusionMode | None = None,
        sampling: SamplingConfig | None = None,
        panel_models: Sequence[str] | None = None,
        sample_count: int | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> FuseResult:
        """One OpenAI-compatible fusion *step* that may emit tool calls.

        Unlike :meth:`run` (which returns only the fused text), this returns the
        full :class:`FuseResult` so the server can hand the caller the
        synthesizer's ``tool_calls`` and finish with ``finish_reason="tool_calls"``.
        The caller then runs the tools and posts the results back as standard
        OpenAI ``tool`` messages on the next request - matching Chat Completions
        tool semantics (we deliberately do *not* execute tools in-process here).
        Panel members also receive ``tools`` so candidate trajectories are
        tool-aware.
        """
        selected_mode = self._resolve_mode(messages, mode)
        selected_sampling = sampling or self.config.sampling
        if selected_mode == "single":
            response = await self._client(self.config.default_model).chat(
                messages, selected_sampling, tools=tools, tool_choice=tool_choice
            )
            return FuseResult(
                response=response,
                terminal=not response.tool_calls,
                analysis=FusionAnalysis(),
                trajectory=None,
            )
        trajectories = await self._generate_trajectories(
            mode=selected_mode,
            messages=messages,
            sampling=selected_sampling,
            panel_models=panel_models,
            sample_count=sample_count,
            tools=tools,
        )
        survivors = [t for t in trajectories if t.status == "succeeded"] or list(trajectories)
        return await self.judge_synthesizer.fuse(
            messages,
            survivors,
            judge_client=self._client(self.config.resolved_judge_model),
            synthesizer_client=self._client(self.config.resolved_synthesizer_model),
            sampling=self.config.sampling,
            tools=tools,
            tool_choice=tool_choice,
        )

    async def run_stream(
        self,
        messages: Sequence[ChatMessage],
        *,
        mode: FusionMode | None = None,
        sampling: SamplingConfig | None = None,
        panel_models: Sequence[str] | None = None,
        sample_count: int | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        """Stream the fused answer: real token streaming on the synthesizer turn.

        Yields :class:`StreamChunk`s while the synthesizer streams, then a final
        :class:`FuseResult`. For ``single`` mode the one model is streamed
        directly; for ``self``/``panel`` the candidate trajectories are generated
        (non-streaming) and only the synthesizer turn streams. Trajectory
        generation happens before any chunk is yielded so generation failures
        surface to the caller before the SSE stream opens.
        """
        selected_mode = self._resolve_mode(messages, mode)
        selected_sampling = sampling or self.config.sampling
        if selected_mode == "single":
            async for item in self._stream_client(
                self._client(self.config.default_model),
                messages,
                selected_sampling,
                tools,
                tool_choice,
            ):
                yield item
            return
        trajectories = await self._generate_trajectories(
            mode=selected_mode,
            messages=messages,
            sampling=selected_sampling,
            panel_models=panel_models,
            sample_count=sample_count,
            tools=tools,
        )
        survivors = [t for t in trajectories if t.status == "succeeded"] or list(trajectories)
        async for item in self.judge_synthesizer.fuse_stream(
            messages,
            survivors,
            judge_client=self._client(self.config.resolved_judge_model),
            synthesizer_client=self._client(self.config.resolved_synthesizer_model),
            sampling=self.config.sampling,
            tools=tools,
            tool_choice=tool_choice,
        ):
            yield item

    def stream_passthrough(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        *,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        """Real token streaming for a single configured endpoint (no fusion).

        Shares the chunk-collection seam with single-mode fusion streaming so
        passthrough and fused streams normalize tool-call fragments identically.
        """
        return self._stream_client(
            self._client(model_id), messages, sampling, tools, tool_choice
        )

    async def _stream_client(
        self,
        client: ChatClient,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None,
        tool_choice: ToolChoice | None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        content_parts: list[str] = []
        tool_accumulator: list[dict[str, str]] = []
        seen_tool_ids: set[str] = set()
        finish_reason: str | None = None
        usage = Usage()
        async for chunk in client.stream_chat(
            messages, sampling, tools=tools, tool_choice=tool_choice
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
        # A terminal FuseResult keeps the server's streaming consumer uniform;
        # a single endpoint has no panel to fuse, so it carries no fused trajectory.
        yield FuseResult(
            response=ModelResponse(
                model_id=client.model_id,
                content="".join(content_parts),
                finish_reason=finish_reason or ("tool_calls" if tool_calls else "stop"),
                usage=usage,
                tool_calls=tool_calls,
            ),
            terminal=not tool_calls,
            analysis=FusionAnalysis(),
            trajectory=None,
        )

    def _resolve_mode(
        self,
        messages: Sequence[ChatMessage],
        mode: FusionMode | None,
    ) -> FusionMode:
        selected_mode = mode or self.config.default_mode
        if selected_mode == "router":
            return self.router.route(messages).route
        return selected_mode

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
