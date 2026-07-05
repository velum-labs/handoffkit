from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

from fusionkit_core.config import SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk

ToolDefinition = Mapping[str, Any]
ToolChoice = str | Mapping[str, Any]

@runtime_checkable
class ChatClient(Protocol):
    model_id: str

    @property
    def max_context(self) -> int | None:
        """The model's context window (endpoint ``max_context``), or None.

        Travels on the client so budget-aware callers (the judge/synthesizer
        packing) see the limit of the *resolved* model even when it was
        selected per request. A read-only property on the protocol so
        implementations may use a plain attribute of any compatible type.
        """
        ...

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        """Generate a chat completion."""
        ...

    def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream a chat completion as incremental chunks."""
        ...

    async def aclose(self) -> None:
        """Release any underlying network resources (HTTP connection pool)."""
        ...
