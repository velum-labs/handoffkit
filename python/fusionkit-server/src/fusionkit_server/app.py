from __future__ import annotations

import json
import logging
import os
import time
import traceback
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import ChatClient, build_clients
from fusionkit_core.config import FusionConfig, PromptOverrides
from fusionkit_core.contracts import (
    FusionRunRequestV1,
    TrajectoryV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult, sum_usages
from fusionkit_core.kernel import FusionKernel
from fusionkit_core.producers import trajectory_from_contract
from fusionkit_core.registry import FUSION_DEFAULT_ALIAS
from fusionkit_core.run import (
    CreateRunResult,
    FusionRunManager,
    NativeRunError,
    ToolResultSubmission,
)
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_core.trace import context_from_headers
from fusionkit_core.types import (
    ChatMessage,
    ModelResponse,
    PanelMode,
    StreamChunk,
    Usage,
)
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)


class TrajectoryItemInput(BaseModel):
    index: int
    type: str
    text: str | None = None
    call_id: str | None = None
    name: str | None = None
    arguments: str | None = None
    is_error: bool | None = None
    output_hash: str | None = None


class TrajectoryInput(BaseModel):
    trajectory_id: str
    model_id: str
    status: str
    items: list[TrajectoryItemInput] = Field(default_factory=list)
    final_output: str
    candidate_id: str | None = None
    model: str | None = None
    harness_kind: str | None = None
    diff: str | None = None
    metadata: dict[str, Any] | None = None


class FuseTrajectoriesRequest(BaseModel):
    """One internal fusion step over externally produced trajectories."""

    model: str = FUSION_DEFAULT_ALIAS
    messages: list[ChatMessage] = Field(min_length=1)
    trajectories: list[TrajectoryInput] = Field(default_factory=list)
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    judge_model: str | None = None
    synthesizer_model: str | None = None
    prompts: PromptOverrides | None = None
    panel_mode: PanelMode = "trajectory"
    stream: bool = False

    @model_validator(mode="after")
    def _require_successful_trajectory(self) -> FuseTrajectoriesRequest:
        if not any(trajectory.status == "succeeded" for trajectory in self.trajectories):
            raise ValueError("at least one succeeded trajectory is required")
        return self


def _package_version() -> str:
    try:
        return distribution_version("fusionkit-server")
    except PackageNotFoundError:
        return "0.0.0"


def create_app(
    config: FusionConfig,
    clients: dict[str, ChatClient] | None = None,
    run_manager: FusionRunManager | None = None,
    run_store_path: Path | None = None,
) -> FastAPI:
    model_clients = clients or build_clients(config)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            seen: set[int] = set()
            for client in model_clients.values():
                if id(client) in seen:
                    continue
                seen.add(id(client))
                try:
                    await client.aclose()
                except Exception:  # noqa: BLE001 - close all remaining clients
                    logger.exception("failed to close RouteKit client %s", client.model_id)

    app = FastAPI(
        title="fusionkit-sidecar",
        version=_package_version(),
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    engine = FusionEngine(config=config, clients=model_clients)
    native_runs = run_manager or _create_run_manager(engine, run_store_path)
    kernel = FusionKernel(engine, native_runs)
    identity = os.environ.get("FUSIONKIT_SIDECAR_IDENTITY", "")

    @app.get("/health")
    async def health() -> dict[str, str]:
        payload = {"status": "ok"}
        if identity:
            payload["identity"] = identity
        return payload

    @app.post("/v1/fusion/runs")
    async def create_fusion_run(
        request: FusionRunRequestV1,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JSONResponse:
        result = await kernel.create_and_run(request, idempotency_key=idempotency_key)
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
            return _json_response(kernel.read_summary(run_id).model_dump(mode="json"))
        except FileNotFoundError:
            return _run_not_found_response()

    @app.get("/v1/fusion/runs/{run_id}/inspect")
    async def inspect_fusion_run(run_id: str) -> JSONResponse:
        try:
            return _json_response(kernel.inspect_run(run_id).model_dump(mode="json"))
        except FileNotFoundError:
            return _run_not_found_response()

    @app.get("/v1/fusion/runs/{run_id}/events")
    async def fusion_run_events(
        run_id: str,
        after: int | None = Query(default=None, ge=0),
    ) -> JSONResponse:
        try:
            kernel.read_summary(run_id)
        except FileNotFoundError:
            return _run_not_found_response()
        return _json_response(kernel.event_page(run_id, after).model_dump(mode="json"))

    @app.post("/v1/fusion/runs/{run_id}/tool-results")
    async def submit_tool_results(
        run_id: str,
        submission: ToolResultSubmission,
    ) -> JSONResponse:
        try:
            result = kernel.submit_tool_result(run_id, submission)
        except FileNotFoundError:
            return _run_not_found_response()
        if isinstance(result, NativeRunError):
            return _native_error_response(result, status_code=409)
        return _json_response(result.model_dump(mode="json"))

    @app.post("/v1/fusion/trajectories:fuse", response_model=None)
    async def fuse_trajectories(
        request: FuseTrajectoriesRequest,
        http_request: Request,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        judge_model = request.judge_model or config.resolved_judge_model
        synthesizer_model = (
            request.synthesizer_model
            or request.judge_model
            or config.resolved_synthesizer_model
        )
        for endpoint_id in (judge_model, synthesizer_model):
            try:
                config.require_endpoint(endpoint_id)
            except KeyError:
                return _error_response(
                    "unknown_endpoint",
                    f"Unknown RouteKit endpoint {endpoint_id!r}.",
                    status_code=400,
                )
        trajectories = [
            trajectory_from_contract(
                TrajectoryV1.model_validate(
                    {
                        **contract_metadata("trajectory.v1"),
                        **trajectory.model_dump(exclude_none=True),
                    }
                )
            )
            for trajectory in request.trajectories
        ]
        tools = _normalize_tools(request.tools)
        tool_choice = _normalize_tool_choice(request.tool_choice)
        trace = context_from_headers(dict(http_request.headers))
        if request.stream:
            stream = kernel.fuse_trajectories_stream(
                request.messages,
                trajectories,
                judge_model=judge_model,
                synthesizer_model=synthesizer_model,
                sampling=config.sampling,
                tools=tools,
                tool_choice=tool_choice,
                prompts=request.prompts,
                panel_mode=request.panel_mode,
                trace=trace,
            )
            return StreamingResponse(
                _fused_completion_sse(request.model, stream),
                media_type="text/event-stream",
            )
        try:
            result = await kernel.fuse_trajectories(
                request.messages,
                trajectories,
                judge_model=judge_model,
                synthesizer_model=synthesizer_model,
                sampling=config.sampling,
                tools=tools,
                tool_choice=tool_choice,
                prompts=request.prompts,
                panel_mode=request.panel_mode,
                trace=trace,
            )
        except Exception:  # noqa: BLE001 - internal boundary returns a stable error
            traceback.print_exc()
            return _error_response(
                "fusion_failed",
                "fusion step failed; see the sidecar logs for details",
                status_code=502,
            )
        return _step_response(
            request.model,
            result.response,
            _fusion_extension(result),
            usage=_fuse_step_usage(result),
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


def _native_error_response(
    error: NativeRunError | None,
    status_code: int,
) -> JSONResponse:
    resolved = error or NativeRunError(
        error_kind="internal_error",
        error_code="unknown_native_run_error",
        retryable=False,
        owner="fusionkit",
        terminal_reason="unknown_native_run_error",
    )
    return _json_response({"error": resolved.model_dump(mode="json")}, status_code)


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


def _error_response(code: str, message: str, status_code: int) -> JSONResponse:
    return _json_response(
        {"error": {"message": message, "type": "sidecar_error", "code": code}},
        status_code,
    )


_NON_TOOL_TYPES = frozenset(
    {"function", "custom", "auto", "none", "required", "any", "tool"}
)


def _resolved_tool_name(entry: dict[str, Any], function: dict[str, Any]) -> str:
    name = function.get("name", "")
    if isinstance(name, str) and name:
        return name
    kind = entry.get("type", "")
    if isinstance(kind, str) and kind and kind not in _NON_TOOL_TYPES:
        return kind
    return ""


def _normalize_tools(
    tools: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    normalized: list[dict[str, Any]] = []
    for entry in tools:
        function = entry.get("function") if "function" in entry else entry
        if not isinstance(function, dict):
            continue
        name = _resolved_tool_name(entry, function)
        if not name:
            continue
        normalized.append(
            {
                "name": name,
                "description": function.get("description", ""),
                "parameters": function.get(
                    "parameters", {"type": "object", "properties": {}}
                ),
            }
        )
    return normalized or None


def _normalize_tool_choice(
    choice: str | dict[str, Any] | None,
) -> str | dict[str, Any] | None:
    if choice is None or isinstance(choice, str):
        return choice
    function = choice.get("function") if "function" in choice else choice
    name = _resolved_tool_name(choice, function) if isinstance(function, dict) else ""
    return {"name": name} if name else None


def _tool_calls_payload(response: ModelResponse) -> list[dict[str, Any]]:
    return [
        {
            "id": call.id or f"call_{index}",
            "type": "function",
            "function": {"name": call.name, "arguments": call.arguments},
        }
        for index, call in enumerate(response.tool_calls)
    ]


def _usage_payload(usage: Usage) -> dict[str, Any]:
    return {
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
    }


def _fuse_step_usage(result: FuseResult) -> Usage:
    usages = [result.turn_usage()]
    if result.panel_usage is not None:
        usages.insert(0, result.panel_usage)
    return sum_usages(usages)


def _fusion_extension(result: FuseResult) -> dict[str, Any] | None:
    trajectory = result.trajectory
    if not result.terminal or trajectory is None:
        best = result.analysis.best_trajectory
        return {"analysis": {"best_trajectory": best}} if best else None
    return {
        "trajectory": {
            "trajectory_id": trajectory.id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "final_output": trajectory.content,
            "synthesis": (
                trajectory.synthesis.model_dump(mode="json")
                if trajectory.synthesis is not None
                else None
            ),
        }
    }


def _step_response(
    model: str,
    response: ModelResponse,
    fusion: dict[str, Any] | None = None,
    *,
    usage: Usage | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": response.content or ""}
    if response.reasoning:
        message["reasoning_content"] = response.reasoning
    tool_calls = _tool_calls_payload(response)
    if tool_calls:
        message["tool_calls"] = tool_calls
    payload: dict[str, Any] = {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": (
                    "tool_calls" if tool_calls else response.finish_reason or "stop"
                ),
            }
        ],
        "usage": _usage_payload(usage or response.usage),
    }
    if fusion is not None:
        payload["fusion"] = fusion
    return payload


async def _fused_completion_sse(
    model: str,
    stream: AsyncIterator[StreamChunk | FuseResult],
) -> AsyncIterator[str]:
    completion_id = f"chatcmpl-{uuid.uuid4()}"
    created = int(time.time())

    def chunk(
        delta: dict[str, Any],
        finish: str | None,
        extra: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if extra:
            payload.update(extra)
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant"}, None)
    final_result: FuseResult | None = None
    streamed_content = False
    try:
        async for item in stream:
            if isinstance(item, FuseResult):
                final_result = item
            else:
                if item.reasoning_delta:
                    yield chunk({"reasoning_content": item.reasoning_delta}, None)
                if item.model_reasoning_delta:
                    yield chunk({"reasoning": item.model_reasoning_delta}, None)
                if item.delta:
                    streamed_content = True
                    yield chunk({"content": item.delta}, None)
    except Exception:  # noqa: BLE001 - stream a stable internal error
        traceback.print_exc()
        error = {"error": {"type": "sidecar_error", "code": "fusion_failed"}}
        yield f"data: {json.dumps(error)}\n\n"
        yield "data: [DONE]\n\n"
        return
    response = final_result.response if final_result is not None else None
    tool_calls = _tool_calls_payload(response) if response is not None else []
    if response is not None and not streamed_content and response.content and not tool_calls:
        yield chunk({"content": response.content}, None)
    if tool_calls:
        yield chunk(
            {
                "tool_calls": [
                    {"index": index, **call}
                    for index, call in enumerate(tool_calls)
                ]
            },
            None,
        )
    finish = (
        "tool_calls"
        if tool_calls
        else (response.finish_reason if response is not None else None) or "stop"
    )
    extra: dict[str, Any] = {}
    if final_result is not None:
        fusion = _fusion_extension(final_result)
        if fusion is not None:
            extra["fusion"] = fusion
        extra["usage"] = _usage_payload(_fuse_step_usage(final_result))
    yield chunk({}, finish, extra)
    yield "data: [DONE]\n\n"


__all__ = [
    "FuseTrajectoriesRequest",
    "TrajectoryInput",
    "TrajectoryItemInput",
    "create_app",
]
