from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import SamplingConfig
from fusionkit_core.types import Candidate, ChatMessage


class PanelRunner:
    def __init__(self, clients: Mapping[str, ChatClient]) -> None:
        self._clients = dict(clients)

    async def generate_single(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> Candidate:
        client = self._client(model_id)
        response = await client.chat(messages, sampling)
        return Candidate(
            id=f"{model_id}:0",
            model_id=model_id,
            content=response.content,
            metadata={
                "latency_s": response.latency_s,
                "usage": response.usage.model_dump(),
                "finish_reason": response.finish_reason,
            },
        )

    async def generate_self_fusion(
        self,
        model_id: str,
        messages: Sequence[ChatMessage],
        base_sampling: SamplingConfig,
        temperatures: Sequence[float],
        sample_count: int,
    ) -> list[Candidate]:
        selected_temperatures = list(temperatures)[:sample_count]
        if len(selected_temperatures) < sample_count:
            selected_temperatures.extend([base_sampling.temperature] * (sample_count - len(selected_temperatures)))

        tasks = []
        for index, temperature in enumerate(selected_temperatures):
            sampling = base_sampling.model_copy(
                update={
                    "temperature": temperature,
                    "seed": None if base_sampling.seed is None else base_sampling.seed + index,
                }
            )
            tasks.append(self._generate_candidate(model_id, index, messages, sampling))
        return list(await asyncio.gather(*tasks))

    async def generate_panel(
        self,
        model_ids: Sequence[str],
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> list[Candidate]:
        tasks = [
            self._generate_candidate(model_id, index, messages, sampling)
            for index, model_id in enumerate(model_ids)
        ]
        return list(await asyncio.gather(*tasks))

    async def _generate_candidate(
        self,
        model_id: str,
        index: int,
        messages: Sequence[ChatMessage],
        sampling: SamplingConfig,
    ) -> Candidate:
        client = self._client(model_id)
        response = await client.chat(messages, sampling)
        return Candidate(
            id=f"{model_id}:{index}",
            model_id=model_id,
            content=response.content,
            metadata={
                "temperature": sampling.temperature,
                "seed": sampling.seed,
                "latency_s": response.latency_s,
                "usage": response.usage.model_dump(),
                "finish_reason": response.finish_reason,
            },
        )

    def _client(self, model_id: str) -> ChatClient:
        try:
            return self._clients[model_id]
        except KeyError as exc:
            raise KeyError(f"No client configured for model: {model_id}") from exc
