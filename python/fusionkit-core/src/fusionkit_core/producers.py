"""Pluggable trajectory generation.

The fusion engine consumes a list of :class:`~fusionkit_core.types.Trajectory`
regardless of how they were produced. A :class:`TrajectoryProducer` is the seam
that produces them:

- :class:`ChatTrajectoryProducer` - in-process, one chat call per attempt ->
  zero-step trajectories (the old ``PanelRunner``).
- :class:`AgentTrajectoryProducer` - in-process bounded agent loop using the
  model's tool calls, delegating tool *execution* to an injected
  :class:`ToolExecutor` so core never embeds a sandbox.
- :class:`ExternalTrajectoryProducer` - wraps trajectories produced by an
  external harness (cursorkit/handoffkit) and submitted over the wire.

Tool execution is delegated through the :class:`ToolExecutor` protocol; core owns
the control flow, the harness/sandbox owns execution.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.contracts import (
    ContractUsage,
    TrajectoryStep,
    TrajectoryV1,
    contract_metadata,
)
from fusionkit_core.types import ChatMessage, ModelResponse, Trajectory


def trajectory_from_response(
    model_id: str,
    response: ModelResponse,
    *,
    ordinal: int = 0,
    sampling: SamplingConfig | None = None,
) -> Trajectory:
    """Single chokepoint that lifts a chat response into a zero-step trajectory.

    Every internally generated trajectory flows through here so the runtime
    ``Trajectory`` shape is constructed in exactly one place.
    """
    metadata: dict[str, Any] = {
        "latency_s": response.latency_s,
        "usage": response.usage.model_dump(),
        "finish_reason": response.finish_reason,
    }
    if sampling is not None:
        metadata["temperature"] = sampling.temperature
        metadata["seed"] = sampling.seed
    return Trajectory(
        id=f"{model_id}:{ordinal}",
        model_id=model_id,
        content=response.content,
        steps=[],
        status="succeeded",
        metadata=metadata,
    )


def failed_trajectory(
    model_id: str,
    exc: BaseException,
    *,
    ordinal: int = 0,
    sampling: SamplingConfig | None = None,
) -> Trajectory:
    """Lift a failed model call into a ``status="failed"`` trajectory.

    The exception is recorded in ``metadata`` so the failure stays visible in
    the result and metrics rather than aborting the whole panel.
    """
    metadata: dict[str, Any] = {
        "error_code": exc.__class__.__name__,
        "error_message": str(exc),
    }
    if sampling is not None:
        metadata["temperature"] = sampling.temperature
        metadata["seed"] = sampling.seed
    return Trajectory(
        id=f"{model_id}:{ordinal}",
        model_id=model_id,
        content="",
        steps=[],
        status="failed",
        metadata=metadata,
    )


class PanelExhaustedError(RuntimeError):
    """Raised when every model in a panel/self-fusion attempt failed.

    A panel tolerates individual model failures, but if there are zero
    survivors there is nothing to fuse, so the whole run must fail.
    """


def trajectory_to_contract(
    trajectory: Trajectory,
    *,
    trajectory_id: str | None = None,
) -> TrajectoryV1:
    """Convert a runtime trajectory into the wire contract record."""
    usage = trajectory.metadata.get("usage")
    contract_usage = None
    if isinstance(usage, Mapping):
        contract_usage = ContractUsage.model_validate(
            {
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
            }
        )
    return TrajectoryV1.model_validate(
        {
            **contract_metadata("trajectory.v1"),
            "trajectory_id": trajectory_id or trajectory.id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "steps": [step.model_dump() for step in trajectory.steps],
            "final_output": trajectory.content,
            "usage": contract_usage.model_dump() if contract_usage is not None else None,
            "metadata": trajectory.metadata or None,
        }
    )


def trajectory_from_contract(record: TrajectoryV1) -> Trajectory:
    """Convert a wire contract record into a runtime trajectory."""
    return Trajectory(
        id=record.trajectory_id,
        model_id=record.model_id,
        content=record.final_output,
        steps=list(record.steps),
        status=record.status,
        metadata=dict(record.metadata or {}),
    )


class ToolExecutor(Protocol):
    """Executes a single tool call and returns its output.

    Implemented by the harness/sandbox (handoffkit, cursorkit). Core only calls
    it; it never embeds execution.
    """

    async def execute(
        self,
        tool_name: str,
        arguments: str,
        *,
        tool_call_id: str | None = None,
    ) -> str: ...


class TrajectoryProducer(Protocol):
    async def produce(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> list[Trajectory]: ...


class ChatTrajectoryProducer:
    """In-process producer: one chat call per attempt -> zero-step trajectories."""

    def __init__(self, clients: Mapping[str, ChatClient]) -> None:
        self._clients = dict(clients)

    async def generate_single(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> Trajectory:
        client = self._client(model_id)
        response = await client.chat(messages, sampling)
        return trajectory_from_response(model_id, response, ordinal=0)

    async def generate_self_fusion(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        base_sampling: SamplingConfig,
        temperatures: Sequence[float],
        sample_count: int,
    ) -> list[Trajectory]:
        selected_temperatures = list(temperatures)[:sample_count]
        if len(selected_temperatures) < sample_count:
            missing_count = sample_count - len(selected_temperatures)
            selected_temperatures.extend([base_sampling.temperature] * missing_count)

        specs: list[tuple[str, int, SamplingConfig]] = []
        for index, temperature in enumerate(selected_temperatures):
            sampling = base_sampling.model_copy(
                update={
                    "temperature": temperature,
                    "seed": None if base_sampling.seed is None else base_sampling.seed + index,
                }
            )
            specs.append((model_id, index, sampling))
        return await self._settle(specs, messages)

    async def generate_panel(
        self,
        model_ids: Sequence[str],
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> list[Trajectory]:
        specs = [
            (model_id, index, sampling) for index, model_id in enumerate(model_ids)
        ]
        return await self._settle(specs, messages)

    async def _settle(
        self,
        specs: Sequence[tuple[str, int, SamplingConfig]],
        messages: Sequence[ChatMessage],
    ) -> list[Trajectory]:
        """Run every attempt, tolerating individual failures.

        Exceptions become ``status="failed"`` trajectories so survivors can
        still be fused. If there are zero survivors, raise
        :class:`PanelExhaustedError`.
        """
        results = await asyncio.gather(
            *(self._generate(model_id, index, messages, sampling)
              for model_id, index, sampling in specs),
            return_exceptions=True,
        )
        trajectories: list[Trajectory] = []
        for (model_id, index, sampling), result in zip(specs, results, strict=True):
            if isinstance(result, BaseException):
                trajectories.append(
                    failed_trajectory(model_id, result, ordinal=index, sampling=sampling)
                )
            else:
                trajectories.append(result)
        if not any(trajectory.status == "succeeded" for trajectory in trajectories):
            errors = ", ".join(
                f"{trajectory.model_id}: "
                f"{trajectory.metadata.get('error_message', 'unknown error')}"
                for trajectory in trajectories
            )
            raise PanelExhaustedError(f"All models failed ({errors})")
        return trajectories

    async def _generate(
        self,
        model_id: str,
        index: int,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> Trajectory:
        client = self._client(model_id)
        response = await client.chat(messages, sampling)
        return trajectory_from_response(model_id, response, ordinal=index, sampling=sampling)

    def _client(self, model_id: str) -> ChatClient:
        try:
            return self._clients[model_id]
        except KeyError as exc:
            raise KeyError(f"No client configured for model: {model_id}") from exc


class ExternalTrajectoryProducer:
    """Wraps trajectories produced elsewhere (an external coding harness)."""

    def __init__(self, trajectories: Sequence[Trajectory]) -> None:
        self._trajectories = list(trajectories)

    async def produce(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> list[Trajectory]:
        return list(self._trajectories)


class AgentTrajectoryProducer:
    """In-process bounded agent loop for one model.

    Drives the model's tool-call loop, delegating execution to a
    :class:`ToolExecutor`, and records each reasoning/tool/observation step. The
    loop is bounded by ``max_tool_rounds``; tool execution lives in the injected
    executor so core never grows a sandbox.
    """

    def __init__(
        self,
        clients: Mapping[str, ChatClient],
        executor: ToolExecutor,
        *,
        tools: Sequence[Mapping[str, Any]] | None = None,
        max_tool_rounds: int = 4,
    ) -> None:
        self._clients = dict(clients)
        self._executor = executor
        self._tools = list(tools) if tools is not None else None
        self._max_tool_rounds = max_tool_rounds

    async def generate(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
        *,
        ordinal: int = 0,
    ) -> Trajectory:
        client = self._client(model_id)
        conversation = list(messages)
        steps: list[TrajectoryStep] = []
        step_index = 0
        final = ""
        status = "succeeded"
        for _ in range(self._max_tool_rounds + 1):
            response = await client.chat(
                conversation,
                sampling,
                tools=self._tools,
            )
            if response.content.strip():
                steps.append(
                    TrajectoryStep(index=step_index, type="reasoning", text=response.content)
                )
                step_index += 1
            if not response.tool_calls:
                final = response.content
                break
            conversation.append(
                ChatMessage(
                    role="assistant",
                    content=response.content,
                    tool_calls=response.tool_calls,
                )
            )
            for call in response.tool_calls:
                steps.append(
                    TrajectoryStep(
                        index=step_index,
                        type="tool_call",
                        tool_name=call.name,
                        tool_call_id=call.id,
                        tool_input=call.arguments,
                    )
                )
                step_index += 1
                output = await self._executor.execute(
                    call.name, call.arguments, tool_call_id=call.id
                )
                steps.append(
                    TrajectoryStep(index=step_index, type="observation", text=output)
                )
                step_index += 1
                conversation.append(
                    ChatMessage(role="tool", content=output, tool_call_id=call.id)
                )
        else:
            status = "failed"
        return Trajectory(
            id=f"{model_id}:{ordinal}",
            model_id=model_id,
            content=final,
            steps=steps,
            status=status,
            metadata={},
        )

    def _client(self, model_id: str) -> ChatClient:
        try:
            return self._clients[model_id]
        except KeyError as exc:
            raise KeyError(f"No client configured for model: {model_id}") from exc


__all__ = [
    "AgentTrajectoryProducer",
    "ChatTrajectoryProducer",
    "ExternalTrajectoryProducer",
    "ToolExecutor",
    "TrajectoryProducer",
    "trajectory_from_contract",
    "trajectory_from_response",
    "trajectory_to_contract",
]
