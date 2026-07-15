from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from fusionkit_core.config import SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk

ToolDefinition = Mapping[str, Any]
ToolChoice = str | Mapping[str, Any]


@runtime_checkable
class ChatClient(Protocol):
    """Neutral chat client used by the fusion engine."""

    model_id: str
    max_context: int | None

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse: ...

    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]: ...

    async def aclose(self) -> None: ...
