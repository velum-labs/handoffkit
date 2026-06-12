"""A minimal OpenAI-compatible HTTP client (Node-free, dependency-free).

mlx-lm's server -- the process the repo's TypeScript `mlxServer` owns -- is
exposed as an OpenAI-compatible API, as are Ollama, LM Studio, vLLM, and the
cloud providers. Speaking that one protocol with the standard library keeps
this package free of new dependency pins and makes it work with any of those
backends; MLX is just the spawn mechanism.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import numpy as np


class EndpointError(RuntimeError):
    """The endpoint answered with an HTTP error or an unusable payload."""


@dataclass(frozen=True)
class ChatResult:
    """One chat completion: the text plus the measured wall-clock latency."""

    text: str
    latency_s: float


def _normalise_base_url(base_url: str) -> str:
    """Accept either ``http://host:port`` or ``http://host:port/v1``."""
    trimmed = base_url.rstrip("/")
    return trimmed[: -len("/v1")] if trimmed.endswith("/v1") else trimmed


class OpenAICompatibleClient:
    """Synchronous client for /v1/chat/completions, /v1/embeddings, /v1/models."""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        timeout_s: float = 120.0,
    ):
        self.base_url = _normalise_base_url(base_url)
        self.api_key = api_key
        self.timeout_s = timeout_s

    def _post(self, path: str, payload: dict) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")[:2000]
            raise EndpointError(f"{path} failed with HTTP {error.code}: {body}") from error
        except urllib.error.URLError as error:
            raise EndpointError(f"{path} unreachable at {self.base_url}: {error.reason}") from error

    def _get(self, path: str) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            headers={"Authorization": f"Bearer {self.api_key}"} if self.api_key else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.URLError as error:
            raise EndpointError(f"{path} unreachable at {self.base_url}: {error}") from error

    def chat(
        self,
        model: str,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 256,
        temperature: float = 0.0,
    ) -> ChatResult:
        """One deterministic-leaning completion, with measured latency."""
        messages = (
            [{"role": "system", "content": system}] if system is not None else []
        ) + [{"role": "user", "content": prompt}]
        started = time.monotonic()
        payload = self._post(
            "/v1/chat/completions",
            {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            },
        )
        latency = time.monotonic() - started
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise EndpointError(
                f"/v1/chat/completions returned an unexpected shape: {json.dumps(payload)[:500]}"
            ) from error
        return ChatResult(text=str(content or ""), latency_s=latency)

    def embed(self, model: str, texts: list[str]) -> np.ndarray:
        """Embeddings for a batch of texts, (len(texts), dims)."""
        if not texts:
            return np.zeros((0, 0), dtype=np.float64)
        payload = self._post("/v1/embeddings", {"model": model, "input": texts})
        try:
            rows = sorted(payload["data"], key=lambda item: item["index"])
            matrix = np.asarray([row["embedding"] for row in rows], dtype=np.float64)
        except (KeyError, TypeError) as error:
            raise EndpointError(
                f"/v1/embeddings returned an unexpected shape: {json.dumps(payload)[:500]}"
            ) from error
        if matrix.shape[0] != len(texts):
            raise EndpointError(
                f"/v1/embeddings returned {matrix.shape[0]} rows for {len(texts)} inputs"
            )
        return matrix

    def models(self) -> list[str]:
        """Model ids the endpoint advertises."""
        payload = self._get("/v1/models")
        data = payload.get("data", [])
        return [str(item.get("id", "")) for item in data if isinstance(item, dict)]
