from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from fusionkit_core.clients import ChatClient, ToolChoice, ToolDefinition
from fusionkit_core.config import FusionConfig, FusionMode, PromptOverrides, SamplingConfig
from fusionkit_core.contracts import FusionRunRequestV1
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult, JudgeSynthesizer, judge_synthesizer_for
from fusionkit_core.run import CreateRunResult, FusionRunManager, NativeRunError
from fusionkit_core.run_models import (
    RunEventPage,
    RunInspection,
    RunStateSummary,
    ToolResultSubmission,
)
from fusionkit_core.types import ChatMessage, ModelResponse, PanelMode, StreamChunk, Trajectory


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

    def _judge_synthesizer_for(
        self,
        prompts: PromptOverrides | None,
        panel_mode: PanelMode = "trajectory",
    ) -> JudgeSynthesizer:
        """The engine's cached judge/synthesizer, or a per-request variant.

        The transient variant (per-request prompt overrides, or step mode) is
        built by :func:`judge_synthesizer_for` — the one construction point —
        and is cheap: it holds only prompt strings and policy flags.
        """
        no_overrides = prompts is None or (
            prompts.judge_system is None and prompts.synthesizer_system is None
        )
        if no_overrides:
            return (
                self._engine.judge_synthesizer
                if panel_mode != "step"
                else self._engine.step_judge_synthesizer
            )
        return judge_synthesizer_for(self._engine.config, prompts=prompts, panel_mode=panel_mode)

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
        prompts: PromptOverrides | None = None,
        panel_mode: PanelMode = "trajectory",
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> FuseResult:
        return await self._judge_synthesizer_for(prompts, panel_mode).fuse(
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
        prompts: PromptOverrides | None = None,
        panel_mode: PanelMode = "trajectory",
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        return self._judge_synthesizer_for(prompts, panel_mode).fuse_stream(
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
