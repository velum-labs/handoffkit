from __future__ import annotations

import time
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from fusionkit_core.client_types import ToolChoice, ToolDefinition
from fusionkit_core.config import SamplingConfig
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, Usage


class FakeModelClient:
    def __init__(
        self,
        model_id: str,
        responses: Sequence[str] | None = None,
        max_context: int | None = None,
        reasoning: str | None = None,
    ) -> None:
        self.model_id = model_id
        self.max_context = max_context
        self._responses = list(responses or [])
        # Optional out-of-band reasoning attached to every reply, so tests can
        # exercise the reasoning capture path without a real provider.
        self._reasoning = reasoning
        self._calls = 0

    def _next_content(self, messages: Sequence[ChatMessage], sampling: SamplingConfig) -> str:
        if self._responses:
            content = self._responses[self._calls % len(self._responses)]
        else:
            user_text = " ".join(
                message.content for message in messages if message.role == "user"
            )
            content = (
                f"{self.model_id} response {self._calls + 1} "
                f"at temperature {sampling.temperature}: {user_text}"
            )
        self._calls += 1
        return content

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del tools, tool_choice, extra
        started = time.perf_counter()
        sampling = sampling or SamplingConfig()
        content = self._next_content(messages, sampling)
        return ModelResponse(
            model_id=self.model_id,
            content=content,
            latency_s=time.perf_counter() - started,
            usage=Usage(prompt_tokens=0, completion_tokens=len(content.split())),
            reasoning=self._reasoning,
        )

    async def stream_chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        tools: Sequence[ToolDefinition] | None = None,
        tool_choice: ToolChoice | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del tools, tool_choice, extra
        content = self._next_content(messages, sampling or SamplingConfig())
        if self._reasoning is not None:
            yield StreamChunk(model_reasoning_delta=self._reasoning)
        for token in content.split():
            yield StreamChunk(delta=f"{token} ")
        yield StreamChunk(
            finish_reason="stop",
            usage=Usage(prompt_tokens=0, completion_tokens=len(content.split())),
        )

    async def aclose(self) -> None:
        return None

