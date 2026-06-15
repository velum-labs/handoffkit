from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import ChatClient, LocalModelClient
from fusionkit_core.config import FusionConfig, FusionMode
from fusionkit_core.contracts import FusionRunRequestV1, contract_metadata
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.run import (
    CreateRunResult,
    FusionRunManager,
    NativeRunError,
    RunInspection,
    hash_json,
    make_id,
)
from fusionkit_core.run_store import FileSystemRunStore
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
    run_manager: FusionRunManager | None = None,
    run_store_path: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="fusionkit", version="0.1.0")
    model_clients = clients or {
        endpoint.id: LocalModelClient(endpoint)
        for endpoint in config.endpoints
    }
    engine = FusionEngine(config=config, clients=model_clients)
    native_runs = run_manager or _create_run_manager(engine, run_store_path)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        data = [{"id": "fusionkit/router", "object": "model"}]
        data.extend({"id": endpoint.id, "object": "model"} for endpoint in config.endpoints)
        return {"object": "list", "data": data}

    @app.post("/v1/fusion/runs")
    async def create_fusion_run(
        request: FusionRunRequestV1,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JSONResponse:
        result = await native_runs.create_and_run(request, idempotency_key=idempotency_key)
        if isinstance(result, CreateRunResult):
            if result.idempotency_outcome == "conflict":
                return _native_error_response(result.terminal_error, status_code=409)
            return _json_response(_create_run_payload(result))
        return _json_response(
            {
                "run_id": result.run_id,
                "trace_id": result.trace_id,
                "state": result.state,
                "status": result.status,
                "event_cursor": result.event_cursor,
                "idempotency_outcome": "created",
                "terminal_error": _dump_optional(result.terminal_error),
                "inspection": result.model_dump(mode="json"),
            }
        )

    @app.get("/v1/fusion/runs/{run_id}")
    async def get_fusion_run(run_id: str) -> JSONResponse:
        try:
            return _json_response(native_runs.store.read_summary(run_id).model_dump(mode="json"))
        except FileNotFoundError:
            return _run_not_found_response()

    @app.get("/v1/fusion/runs/{run_id}/inspect")
    async def inspect_fusion_run(run_id: str) -> JSONResponse:
        try:
            return _json_response(native_runs.store.inspect_run(run_id).model_dump(mode="json"))
        except FileNotFoundError:
            return _run_not_found_response()

    @app.get("/v1/fusion/runs/{run_id}/events")
    async def fusion_run_events(
        run_id: str,
        after: int | None = Query(default=None, ge=0),
    ) -> JSONResponse:
        try:
            native_runs.store.read_summary(run_id)
        except FileNotFoundError:
            return _run_not_found_response()
        return _json_response(native_runs.store.event_page(run_id, after).model_dump(mode="json"))

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(request: FusionRequest) -> dict[str, Any] | JSONResponse:
        if request.stream:
            return _openai_error_response(
                "unsupported_streaming",
                "Streaming is not implemented yet.",
                status_code=400,
            )

        run_request = _fusion_request_to_run_request(request, config)
        result = await native_runs.create_and_run(run_request)
        if isinstance(result, CreateRunResult):
            if result.idempotency_outcome == "conflict":
                return _openai_native_error_response(result.terminal_error, status_code=409)
            if result.run_id is None:
                return _openai_error_response(
                    "run_not_available",
                    "Native run did not return a run id.",
                    status_code=500,
                )
            result = native_runs.store.inspect_run(result.run_id)
        if result.state != "completed" or result.final_output is None:
            return _openai_native_error_response(result.terminal_error, status_code=500)
        return _openai_chat_response(
            request.model,
            result.final_output,
            _chat_fusion_metadata(result),
        )

    return app


def _create_run_manager(
    engine: FusionEngine,
    run_store_path: Path | None,
) -> FusionRunManager:
    root = run_store_path or Path(".fusionkit/runs")
    return FusionRunManager(
        engine,
        FileSystemRunStore(root),
        LocalArtifactStore(root),
    )


def _create_run_payload(result: CreateRunResult) -> dict[str, Any]:
    return {
        "run_id": result.run_id,
        "trace_id": result.trace_id,
        "state": result.state,
        "status": result.status,
        "event_cursor": result.event_cursor,
        "idempotency_outcome": result.idempotency_outcome,
        "terminal_error": _dump_optional(result.terminal_error),
    }


def _fusion_request_to_run_request(
    request: FusionRequest,
    config: FusionConfig,
) -> FusionRunRequestV1:
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
    payload = {
        **contract_metadata("fusion-run-request.v1"),
        "request_id": make_id("chat_request"),
        "mode": _mode_from_request(request),
        "messages": [message.model_dump(mode="json") for message in request.messages],
        "sampling": sampling.model_dump(mode="json"),
        "sample_count": request.fusion.sample_count,
        "verify": request.fusion.verify,
        "requested_models": request.fusion.panel_models,
        "tool_policy": "disabled",
    }
    payload["request_hash"] = hash_json(
        {
            "model": request.model,
            "messages": payload["messages"],
            "sampling": payload["sampling"],
            "fusion": request.fusion.model_dump(mode="json"),
        }
    )
    return FusionRunRequestV1.model_validate(payload)


def _chat_fusion_metadata(inspection: RunInspection) -> dict[str, Any]:
    return {
        "run_id": inspection.run_id,
        "trace_id": inspection.trace_id,
        "state": inspection.state,
        "status": inspection.status,
        "event_cursor": inspection.event_cursor,
        "candidate_count": len(inspection.candidates),
        "candidate_model_ids": [candidate.model_id for candidate in inspection.candidates],
    }


def _native_error_response(
    error: NativeRunError | None,
    status_code: int,
) -> JSONResponse:
    resolved_error = error or NativeRunError(
        error_kind="internal_error",
        error_code="unknown_native_run_error",
        retryable=False,
        owner="fusionkit",
        terminal_reason="unknown_native_run_error",
    )
    return _json_response({"error": resolved_error.model_dump(mode="json")}, status_code)


def _openai_native_error_response(
    error: NativeRunError | None,
    status_code: int,
) -> JSONResponse:
    resolved_error = error or NativeRunError(
        error_kind="internal_error",
        error_code="native_run_failed",
        retryable=False,
        owner="fusionkit",
        terminal_reason="native_run_failed",
    )
    return _openai_error_response(
        resolved_error.error_code,
        resolved_error.message or resolved_error.terminal_reason,
        status_code=status_code,
    )


def _openai_error_response(error_code: str, message: str, status_code: int) -> JSONResponse:
    return _json_response(
        {
            "error": {
                "message": message,
                "type": "invalid_request_error",
                "code": error_code,
            }
        },
        status_code=status_code,
    )


def _run_not_found_response() -> JSONResponse:
    return _native_error_response(
        NativeRunError(
            error_kind="validation_error",
            error_code="run_not_found",
            retryable=False,
            owner="fusionkit",
            terminal_reason="unknown_run",
        ),
        status_code=404,
    )


def _json_response(payload: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(content=payload, status_code=status_code)


def _dump_optional(model: BaseModel | None) -> dict[str, Any] | None:
    return None if model is None else model.model_dump(mode="json")


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
