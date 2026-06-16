from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from openai import AsyncOpenAI

from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.providers import resolve_api_key
from fusionkit_core.types import ChatMessage, ModelResponse, Usage


class ChatClient(Protocol):
    model_id: str

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        """Generate a chat completion."""
        ...


class LocalModelClient:
    def __init__(self, endpoint: ModelEndpoint) -> None:
        self.endpoint = endpoint
        self.model_id = endpoint.id
        self._client = AsyncOpenAI(
            base_url=f"{endpoint.base_url}/v1",
            api_key=resolve_api_key(endpoint),
            timeout=endpoint.timeout_s,
        )

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        request_sampling = sampling or SamplingConfig()
        payload: dict[str, Any] = {
            "model": self.endpoint.model,
            "messages": [message.model_dump() for message in messages],
            "temperature": request_sampling.temperature,
            "top_p": request_sampling.top_p,
            "max_tokens": request_sampling.max_tokens,
        }
        if request_sampling.seed is not None:
            payload["seed"] = request_sampling.seed
        if extra:
            payload.update(extra)

        started = time.perf_counter()
        response = await self._client.chat.completions.create(**payload)
        latency_s = time.perf_counter() - started
        choice = response.choices[0]
        usage = Usage()
        if response.usage is not None:
            usage = Usage(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
                total_tokens=response.usage.total_tokens,
            )
        return ModelResponse(
            model_id=self.model_id,
            content=choice.message.content or "",
            finish_reason=choice.finish_reason,
            usage=usage,
            latency_s=latency_s,
            raw=response.model_dump(mode="json"),
        )


class FakeModelClient:
    def __init__(self, model_id: str, responses: Sequence[str] | None = None) -> None:
        self.model_id = model_id
        self._responses = list(responses or [])
        self._calls = 0

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> ModelResponse:
        del extra
        started = time.perf_counter()
        sampling = sampling or SamplingConfig()
        if self._responses:
            content = self._responses[self._calls % len(self._responses)]
        else:
            user_text = " ".join(message.content for message in messages if message.role == "user")
            content = (
                f"{self.model_id} response {self._calls + 1} "
                f"at temperature {sampling.temperature}: {user_text}"
            )
        self._calls += 1
        return ModelResponse(
            model_id=self.model_id,
            content=content,
            latency_s=time.perf_counter() - started,
            usage=Usage(prompt_tokens=0, completion_tokens=len(content.split())),
        )
