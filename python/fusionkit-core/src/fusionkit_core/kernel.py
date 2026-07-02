from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from fusionkit_core.clients import ChatClient, ToolChoice, ToolDefinition
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.contracts import FusionRunRequestV1
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult
from fusionkit_core.producers import ChatTrajectoryProducer
from fusionkit_core.run import CreateRunResult, FusionRunManager, NativeRunError
from fusionkit_core.run_models import (
    RunEventPage,
    RunInspection,
    RunStateSummary,
    ToolResultSubmission,
)
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, Trajectory


class FusionKernel:
    """Compatibility kernel for the Python FusionKit server.

    The TypeScript runtime is the canonical long-term kernel. This wrapper gives
    the Python server the same architectural boundary during migration: FastAPI
    routes call the kernel, and the kernel delegates to the current
    ``FusionEngine``/``FusionRunManager`` internals until those internals are
    replaced or forwarded to the TypeScript runtime.
    """

    def __init__(self, engine: FusionEngine, runs: FusionRunManager) -> None:
        self._engine = engine
        self._runs = runs

    @property
    def config(self) -> FusionConfig:
        return self._engine.config

    @property
    def store(self):
        return self._runs.store

    @property
    def clients(self) -> dict[str, ChatClient]:
        return self._engine.clients

    @property
    def producer(self) -> ChatTrajectoryProducer:
        # The eval harness (candidate-bank builder) generates panel candidates
        # via engine.producer; the kernel facade must expose the same seam.
        return self._engine.producer

    def client(self, model_id: str) -> ChatClient:
        return self._engine.clients[model_id]

    async def run(
        self,
        messages: Sequence[ChatMessage],
        mode: FusionMode | None = None,
        sampling: SamplingConfig | None = None,
        panel_models: Sequence[str] | None = None,
        sample_count: int | None = None,
    ):
        return await self._engine.run(
            messages,
            mode=mode,
            sampling=sampling,
            panel_models=panel_models,
            sample_count=sample_count,
        )

    async def create_and_run(
        self,
        request: FusionRunRequestV1,
        *,
        idempotency_key: str | None = None,
    ) -> RunInspection | CreateRunResult:
        return await self._runs.create_and_run(request, idempotency_key=idempotency_key)

    def read_summary(self, run_id: str) -> RunStateSummary:
        return self._runs.store.read_summary(run_id)

    def inspect_run(self, run_id: str) -> RunInspection:
        return self._runs.store.inspect_run(run_id)

    def event_page(self, run_id: str, after: int | None) -> RunEventPage:
        return self._runs.store.event_page(run_id, after)

    def submit_tool_result(
        self, run_id: str, submission: ToolResultSubmission
    ) -> RunInspection | NativeRunError:
        return self._runs.submit_tool_result(run_id, submission)

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
        return await self._engine.run_step(
            messages,
            mode=mode,
            sampling=sampling,
            panel_models=panel_models,
            sample_count=sample_count,
            tools=tools,
            tool_choice=tool_choice,
        )

    def run_stream(
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
        return self._engine.run_stream(
            messages,
            mode=mode,
            sampling=sampling,
            panel_models=panel_models,
            sample_count=sample_count,
            tools=tools,
            tool_choice=tool_choice,
        )

    def stream_passthrough(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        *,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        return self._engine.stream_passthrough(
            model_id, messages, sampling, tools=tools, tool_choice=tool_choice
        )

    async def passthrough_chat(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        *,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> ModelResponse:
        return await self.client(model_id).chat(
            messages, sampling, tools=tools, tool_choice=tool_choice
        )

    async def fuse_trajectories(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_model: str,
        synthesizer_model: str,
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> FuseResult:
        return await self._engine.judge_synthesizer.fuse(
            messages,
            trajectories,
            judge_client=self.client(judge_model),
            synthesizer_client=self.client(synthesizer_model),
            sampling=sampling,
            tools=tools,
            tool_choice=tool_choice,
            trace_id=trace_id,
            span_id=span_id,
        )

    def fuse_trajectories_stream(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_model: str,
        synthesizer_model: str,
        sampling: SamplingConfig,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        return self._engine.judge_synthesizer.fuse_stream(
            messages,
            trajectories,
            judge_client=self.client(judge_model),
            synthesizer_client=self.client(synthesizer_model),
            sampling=sampling,
            tools=tools,
            tool_choice=tool_choice,
            trace_id=trace_id,
            span_id=span_id,
        )
