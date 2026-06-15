from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from fusionkit_core.clients import ChatClient, LocalModelClient
from fusionkit_core.config import FusionConfig, FusionMode
from fusionkit_core.fusion import FusionEngine, normalize_messages
from fusionkit_core.types import ChatMessage
from pydantic import BaseModel, Field


class FusionOptions(BaseModel):
    mode: FusionMode | None = None
    panel_models: list[str] | None = None
    sample_count: int | None = Field(default=None, ge=1)
    verify: bool = False


class FusionRequest(BaseModel):
    model: str = "fusionkit/router"
    messages: list[ChatMessage]
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    stream: bool = False
    fusion: FusionOptions = Field(default_factory=FusionOptions)


def create_app(
    config: FusionConfig,
    clients: dict[str, ChatClient] | None = None,
) -> FastAPI:
    app = FastAPI(title="fusionkit", version="0.1.0")
    model_clients = clients or {
        endpoint.id: LocalModelClient(endpoint)
        for endpoint in config.endpoints
    }
    engine = FusionEngine(config=config, clients=model_clients)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        data = [{"id": "fusionkit/router", "object": "model"}]
        data.extend({"id": endpoint.id, "object": "model"} for endpoint in config.endpoints)
        return {"object": "list", "data": data}

    @app.post("/v1/chat/completions")
    async def chat_completions(request: FusionRequest) -> dict[str, Any]:
        if request.stream:
            raise HTTPException(status_code=400, detail="Streaming is not implemented yet.")

        mode = _mode_from_request(request)
        sampling = config.sampling.model_copy(
            update={
                key: value
                for key, value in {
                    "temperature": request.temperature,
                    "top_p": request.top_p,
                    "max_tokens": request.max_tokens,
                }.items()
                if value is not None
            }
        )
        result = await engine.run(
            normalize_messages(request.messages),
            mode=mode,
            sampling=sampling,
            panel_models=request.fusion.panel_models,
            sample_count=request.fusion.sample_count,
            verify=request.fusion.verify,
        )
        return _openai_chat_response(request.model, result.content, result.metrics)

    return app


def _mode_from_request(request: FusionRequest) -> FusionMode:
    if request.fusion.mode is not None:
        return request.fusion.mode
    suffix = request.model.rsplit("/", maxsplit=1)[-1]
    if suffix == "single":
        return "single"
    if suffix == "self":
        return "self"
    if suffix == "panel":
        return "panel"
    if suffix == "router":
        return "router"
    return "router"


def _openai_chat_response(model: str, content: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": content,
                },
            }
        ],
        "usage": {
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
        },
        "fusionkit": metadata,
    }
