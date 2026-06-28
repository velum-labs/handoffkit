from __future__ import annotations

import json
import time
import traceback
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, assert_never

from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse, StreamingResponse
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import (
    ChatClient,
    ProviderCallError,
    ProviderErrorCategory,
    build_clients,
)
from fusionkit_core.config import FusionConfig, FusionMode, SamplingConfig
from fusionkit_core.contracts import (
    FusionRunRequestV1,
    TrajectoryV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult
from fusionkit_core.producers import PanelExhaustedError, trajectory_from_contract
from fusionkit_core.run import (
    CreateRunResult,
    FusionRunManager,
    NativeRunError,
    RunInspection,
    ToolExecutionMode,
    ToolExecutionPolicy,
    ToolResultSubmission,
    hash_json,
    make_id,
)
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_core.trace import TRACE_ID_HEADER, TRACE_SPAN_HEADER, new_span_id
from fusionkit_core.types import ChatMessage, ModelResponse, StreamChunk, ToolCall
from pydantic import BaseModel, Field


class FusionToolExecutionOptions(BaseModel):
    mode: ToolExecutionMode = "disabled"
    allowed_side_effects: list[str] = Field(default_factory=lambda: ["read_only"])
    environment: str | None = None
    policy_id: str | None = None
    dedupe_read_only: bool = True


class FusionOptions(BaseModel):
    mode: FusionMode | None = None
    panel_models: list[str] | None = None
    sample_count: int | None = Field(default=None, ge=1)
    tool_execution: FusionToolExecutionOptions = Field(
        default_factory=FusionToolExecutionOptions
    )


class FusionRequest(BaseModel):
    model: str = "fusionkit/router"
    messages: list[ChatMessage]
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    stream: bool = False
    # Forwarded only on the per-model passthrough path (when `model` names a
    # configured endpoint); the fusion path ignores them.
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    fusion: FusionOptions = Field(default_factory=FusionOptions)


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
    """A single fusion step.

    The one fusion operation: the synthesizer produces the next step (a tool call
    for the harness to run) or the final answer, from the candidate trajectories
    plus the live conversation. With no ``tools`` it is terminal on turn 1 (the
    old one-shot text fusion); with tools the harness drives the loop. The
    terminal response carries the fused trajectory (with its ``synthesis``) under
    the ``fusion`` extension.
    """

    model: str = "fusionkit/router"
    # Raw OpenAI chat messages (assistant tool_calls are nested under `function`,
    # tool results carry `tool_call_id`, content may be a parts array); normalized
    # to FusionKit ChatMessage in the handler.
    messages: list[dict[str, Any]]
    trajectories: list[TrajectoryInput] = Field(default_factory=list)
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    judge_model: str | None = None
    synthesizer_model: str | None = None
    stream: bool = False


def create_app(
    config: FusionConfig,
    clients: dict[str, ChatClient] | None = None,
    run_manager: FusionRunManager | None = None,
    run_store_path: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="fusionkit", version="0.2.0")
    model_clients = clients or build_clients(config)
    engine = FusionEngine(config=config, clients=model_clients)
    native_runs = run_manager or _create_run_manager(engine, run_store_path)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        data: list[dict[str, Any]] = [{"id": "fusionkit/router", "object": "model"}]
        data.extend(
            {"id": endpoint.id, "object": "model", "owned_by": endpoint.provider}
            for endpoint in config.endpoints
        )
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

    @app.post("/v1/fusion/runs/{run_id}/tool-results")
    async def submit_tool_results(
        run_id: str,
        submission: ToolResultSubmission,
    ) -> JSONResponse:
        try:
            result = native_runs.submit_tool_result(run_id, submission)
        except FileNotFoundError:
            return _run_not_found_response()
        if isinstance(result, NativeRunError):
            return _native_error_response(result, status_code=409)
        return _json_response(result.model_dump(mode="json"))

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(
        request: FusionRequest,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        # Per-model passthrough: when `model` names a configured endpoint, call
        # that model directly (no fusion run) so a single `fusionkit serve` can
        # front every panel model by id for an external coding harness. The
        # reserved `fusionkit/{router,panel,single,self}` names keep the fusion
        # path below.
        if _is_endpoint_model(config, request.model):
            return await _passthrough_chat(engine, config, request)
        # Real SSE streaming on the fused path: the candidate trajectories are
        # generated, then the synthesizer turn streams tokens straight through
        # (no buffer-then-rechunk).
        if request.stream:
            stream = engine.run_stream(
                request.messages,
                mode=_mode_from_request(request),
                sampling=_request_sampling(config, request),
                panel_models=request.fusion.panel_models,
                sample_count=request.fusion.sample_count,
                tools=_normalize_tools(request.tools),
                tool_choice=_normalize_tool_choice(request.tool_choice),
            )
            return StreamingResponse(
                _fused_completion_sse(request.model, stream),
                media_type="text/event-stream",
            )
        # Tool calling through the ensemble: when the caller passes `tools`, the
        # fused step is allowed to emit `tool_calls`. We return them to the caller
        # (OpenAI Chat Completions semantics) rather than executing in-process;
        # the caller posts `tool` results back on the next request.
        if request.tools:
            return await _fusion_tool_step(engine, config, request)
        resolved = await _resolve_native_chat(native_runs, request, config)
        if isinstance(resolved, JSONResponse):
            return resolved
        final_output, metadata = resolved
        return _openai_chat_response(request.model, final_output, metadata)

    @app.post("/v1/fusion/trajectories:fuse", response_model=None)
    async def fuse_trajectories(
        request: FuseTrajectoriesRequest,
        trace_id: str | None = Header(default=None, alias=TRACE_ID_HEADER),
        span_id: str | None = Header(default=None, alias=TRACE_SPAN_HEADER),
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        judge_model = request.judge_model or config.resolved_judge_model
        synthesizer_model = request.synthesizer_model or config.resolved_synthesizer_model
        try:
            judge_client = engine.clients[judge_model]
            synthesizer_client = engine.clients[synthesizer_model]
        except KeyError as exc:
            return _openai_error_response(
                "unknown_model",
                f"Unknown model endpoint {exc}.",
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
        messages = [_to_chat_message(message) for message in request.messages]
        tools = _normalize_tools(request.tools)
        tool_choice = _normalize_tool_choice(request.tool_choice)
        resolved_span = span_id or new_span_id()
        # Real streaming: the synthesizer turn streams tokens; the fused
        # trajectory metadata rides on the terminal SSE chunk.
        if request.stream:
            stream = engine.judge_synthesizer.fuse_stream(
                messages,
                trajectories,
                judge_client=judge_client,
                synthesizer_client=synthesizer_client,
                sampling=config.sampling,
                tools=tools,
                tool_choice=tool_choice,
                trace_id=trace_id,
                span_id=resolved_span,
            )
            return StreamingResponse(
                _fused_completion_sse(request.model, stream),
                media_type="text/event-stream",
            )
        try:
            result = await engine.judge_synthesizer.fuse(
                messages,
                trajectories,
                judge_client=judge_client,
                synthesizer_client=synthesizer_client,
                sampling=config.sampling,
                tools=tools,
                tool_choice=tool_choice,
                trace_id=trace_id,
                span_id=resolved_span,
            )
        except ProviderCallError as exc:
            return _provider_error_response(exc)
        except Exception as exc:  # noqa: BLE001 - surface as an OpenAI-style error body
            traceback.print_exc()
            return _openai_error_response(
                exc.__class__.__name__,
                f"fusion step failed: {exc}",
                status_code=502,
            )
        return _openai_step_response(request.model, result.response, _fusion_extension(result))

    return app


def _is_endpoint_model(config: FusionConfig, model: str) -> bool:
    try:
        config.endpoint_for(model)
        return True
    except KeyError:
        return False


async def _passthrough_chat(
    engine: FusionEngine,
    config: FusionConfig,
    request: FusionRequest,
) -> dict[str, Any] | JSONResponse | StreamingResponse:
    """Call a single configured endpoint directly, bypassing fusion.

    This is the multi-model analogue of `serve-endpoint`: one server fronts every
    endpoint in the config, routed by the request's `model` (the endpoint id), so
    an OpenAI-compatible caller (e.g. a per-candidate coding harness) can drive any
    panel model — including its tool-call loop — through the same base URL.
    """
    client = engine.clients[request.model]
    sampling = _request_sampling(config, request)
    tools = _normalize_tools(request.tools)
    tool_choice = _normalize_tool_choice(request.tool_choice)
    if request.stream:
        # Real passthrough streaming straight from the provider's stream_chat.
        stream = engine.stream_passthrough(
            request.model,
            request.messages,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        )
        return StreamingResponse(
            _fused_completion_sse(request.model, stream),
            media_type="text/event-stream",
        )
    try:
        response = await client.chat(
            request.messages,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        )
    except ProviderCallError as exc:
        return _provider_error_response(exc)
    except Exception as exc:  # noqa: BLE001 - surface as an OpenAI-style error body
        traceback.print_exc()
        return _openai_error_response(
            exc.__class__.__name__,
            f"passthrough chat failed: {exc}",
            status_code=502,
        )
    return _openai_step_response(request.model, response)


async def _fusion_tool_step(
    engine: FusionEngine,
    config: FusionConfig,
    request: FusionRequest,
) -> dict[str, Any] | JSONResponse:
    """Non-streaming fused step that may return ``tool_calls`` to the caller.

    The ensemble generates tool-aware candidate trajectories, and the synthesizer
    step is allowed to emit ``tool_calls``. Following OpenAI Chat Completions tool
    semantics, those calls are returned to the caller (finish_reason
    ``tool_calls``); the caller executes them and posts ``tool`` result messages
    back on the next request, which re-enter the panel + synthesizer.
    """
    try:
        result = await engine.run_step(
            request.messages,
            mode=_mode_from_request(request),
            sampling=_request_sampling(config, request),
            panel_models=request.fusion.panel_models,
            sample_count=request.fusion.sample_count,
            tools=_normalize_tools(request.tools),
            tool_choice=_normalize_tool_choice(request.tool_choice),
        )
    except ProviderCallError as exc:
        return _provider_error_response(exc)
    except PanelExhaustedError as exc:
        return _openai_error_response(
            "all_models_failed", f"fusion step failed: {exc}", status_code=502
        )
    except Exception as exc:  # noqa: BLE001 - surface as an OpenAI-style error body
        traceback.print_exc()
        return _openai_error_response(
            exc.__class__.__name__, f"fusion step failed: {exc}", status_code=502
        )
    return _openai_step_response(request.model, result.response, _fusion_extension(result))


def _request_sampling(config: FusionConfig, request: FusionRequest) -> SamplingConfig:
    return config.sampling.model_copy(
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


async def _resolve_native_chat(
    native_runs: FusionRunManager,
    request: FusionRequest,
    config: FusionConfig,
) -> tuple[str, dict[str, Any]] | JSONResponse:
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
    return result.final_output, _chat_fusion_metadata(result)


async def _fused_completion_sse(
    model: str,
    stream: AsyncIterator[StreamChunk | FuseResult],
) -> AsyncIterator[str]:
    """Emit OpenAI ``chat.completion.chunk`` SSE from a fused/passthrough stream.

    Consumes the engine's ``AsyncIterator[StreamChunk | FuseResult]``: each
    :class:`StreamChunk` with text becomes a content delta as it arrives (true
    streaming), and the terminal :class:`FuseResult` carries any ``tool_calls``,
    the finish reason, and the fused trajectory metadata (the ``fusion``
    extension) on the final chunk. A mid-stream provider failure is surfaced as
    an OpenAI-style error event before ``[DONE]``.
    """
    completion_id = f"chatcmpl-{uuid.uuid4()}"
    created = int(time.time())

    def chunk(delta: dict[str, Any], finish: str | None, extra: dict[str, Any] | None) -> str:
        payload: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if extra is not None:
            payload.update(extra)
        return f"data: {json.dumps(payload)}\n\n"

    yield chunk({"role": "assistant"}, None, None)
    streamed_content = False
    final_result: FuseResult | None = None
    try:
        async for item in stream:
            if isinstance(item, FuseResult):
                final_result = item
                continue
            if item.delta:
                streamed_content = True
                yield chunk({"content": item.delta}, None, None)
    except Exception as exc:  # noqa: BLE001 - surface as an OpenAI-style error event
        traceback.print_exc()
        yield _sse_error_event(exc)
        yield "data: [DONE]\n\n"
        return

    response = final_result.response if final_result is not None else None
    tool_calls = _tool_calls_payload(response) if response is not None else []
    # If nothing streamed (e.g. a reasoning model that produced its answer only
    # via the post-stream fallback), emit the resolved content once before close.
    if response is not None and not streamed_content and response.content and not tool_calls:
        yield chunk({"content": response.content}, None, None)
    if tool_calls:
        yield chunk(
            {"tool_calls": [{"index": index, **call} for index, call in enumerate(tool_calls)]},
            None,
            None,
        )
    finish = "tool_calls" if tool_calls else (
        (response.finish_reason if response is not None else None) or "stop"
    )
    extra: dict[str, Any] = {}
    if final_result is not None:
        fusion_extension = _fusion_extension(final_result)
        if fusion_extension is not None:
            extra["fusion"] = fusion_extension
    # WS7: carry the synthesizer turn's token usage on the terminal chunk so a
    # streaming client (and the Node gateway's cost meter, which reads `usage`
    # off the SSE tail) can account a fused stream's cost — mirroring the
    # non-streaming `_openai_step_response` body, which always includes `usage`.
    if response is not None:
        extra["usage"] = _usage_dict(response)
    yield chunk({}, finish, extra or None)
    yield "data: [DONE]\n\n"


def _sse_error_event(exc: BaseException) -> str:
    if isinstance(exc, ProviderCallError):
        body: dict[str, Any] = {
            "message": str(exc),
            "type": "provider_error",
            "code": exc.category,
            # Mirror the non-streaming error body so a mid-stream failure carries
            # the same canonical ``error_category`` failover signal (WS5).
            "error_category": exc.category,
            "category": exc.category,
            "provider": exc.provider,
        }
        if exc.retry_after is not None:
            body["retry_after"] = exc.retry_after
    else:
        body = {
            "message": str(exc),
            "type": exc.__class__.__name__,
            "code": exc.__class__.__name__,
        }
    return f"data: {json.dumps({'error': body})}\n\n"


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
        "messages": [
            message.model_dump(mode="json", include={"role", "content"})
            for message in request.messages
        ],
        "sampling": sampling.model_dump(mode="json"),
        "sample_count": request.fusion.sample_count,
        "requested_models": request.fusion.panel_models,
        "tool_policy": _tool_policy_from_options(request.fusion.tool_execution),
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


def _tool_policy_from_options(options: FusionToolExecutionOptions) -> str:
    if options.mode == "external":
        return "external_pause"
    if options.mode == "executor":
        return "allowed"
    return "disabled"


def _tool_execution_policy_from_options(options: FusionToolExecutionOptions) -> ToolExecutionPolicy:
    return ToolExecutionPolicy.model_validate(
        {
            "mode": options.mode,
            "allowed_side_effects": options.allowed_side_effects,
            "environment": options.environment,
            "policy_id": options.policy_id,
            "dedupe_read_only": options.dedupe_read_only,
        }
    )


def _chat_fusion_metadata(inspection: RunInspection) -> dict[str, Any]:
    return {
        "run_id": inspection.run_id,
        "trace_id": inspection.trace_id,
        "state": inspection.state,
        "status": inspection.status,
        "event_cursor": inspection.event_cursor,
        "trajectory_count": len(inspection.trajectories),
        "trajectory_model_ids": [
            trajectory.model_id for trajectory in inspection.trajectories
        ],
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


def _coerce_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


def _to_chat_message(message: dict[str, Any]) -> ChatMessage:
    """Normalize a raw OpenAI chat message into a FusionKit ChatMessage,
    flattening nested ({function:{name,arguments}}) tool calls."""
    kwargs: dict[str, Any] = {
        "role": message.get("role", "user"),
        "content": _coerce_message_content(message.get("content")),
    }
    if message.get("tool_call_id"):
        kwargs["tool_call_id"] = message["tool_call_id"]
    if message.get("name"):
        kwargs["name"] = message["name"]
    tool_calls = message.get("tool_calls")
    if tool_calls:
        parsed: list[ToolCall] = []
        for call in tool_calls:
            function = (
                call.get("function") if isinstance(call, dict) and "function" in call else call
            )
            function = function if isinstance(function, dict) else {}
            parsed.append(
                ToolCall(
                    id=call.get("id", "") if isinstance(call, dict) else "",
                    name=function.get("name", ""),
                    arguments=function.get("arguments", "{}") or "{}",
                )
            )
        if parsed:
            kwargs["tool_calls"] = parsed
    return ChatMessage(**kwargs)


def _normalize_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Accept OpenAI-nested ({type:function, function:{...}}) or flat tool defs and
    return the flat {name, description, parameters} shape FusionKit's clients expect."""
    if not tools:
        return None
    normalized: list[dict[str, Any]] = []
    for entry in tools:
        function = (
            entry.get("function") if isinstance(entry, dict) and "function" in entry else entry
        )
        if not isinstance(function, dict):
            continue
        name = function.get("name", "")
        # Skip tools without a usable name (some agent CLIs advertise custom or
        # freeform tool shapes that resolve to an empty name, which providers reject).
        if not isinstance(name, str) or not name:
            continue
        normalized.append(
            {
                "name": name,
                "description": function.get("description", ""),
                "parameters": function.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return normalized or None


def _normalize_tool_choice(choice: str | dict[str, Any] | None) -> str | dict[str, Any] | None:
    if choice is None or isinstance(choice, str):
        return choice
    if isinstance(choice, dict):
        function = choice.get("function") if "function" in choice else choice
        name = function.get("name") if isinstance(function, dict) else None
        if isinstance(name, str) and name:
            return {"name": name}
    return None


def _tool_calls_payload(response: ModelResponse) -> list[dict[str, Any]]:
    return [
        {
            "id": call.id or f"call_{index}",
            "type": "function",
            "function": {"name": call.name, "arguments": call.arguments},
        }
        for index, call in enumerate(response.tool_calls)
    ]


def _usage_dict(response: ModelResponse) -> dict[str, Any]:
    return {
        "prompt_tokens": response.usage.prompt_tokens,
        "completion_tokens": response.usage.completion_tokens,
        "total_tokens": response.usage.total_tokens,
    }


def _fusion_extension(result: FuseResult) -> dict[str, Any] | None:
    """The ``fusion`` extension carried on a terminal fuse response.

    On the terminal step the fused output is a trajectory whose ``synthesis``
    holds the fusion result (decision/selected/rationale/metrics). It rides on the
    chat completion so the gateway can surface it without a separate record."""
    trajectory = result.trajectory
    if not result.terminal or trajectory is None:
        return None
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


def _openai_step_response(
    model: str,
    response: ModelResponse,
    fusion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": response.content or ""}
    tool_calls = _tool_calls_payload(response)
    if tool_calls:
        message["tool_calls"] = tool_calls
    finish_reason = "tool_calls" if tool_calls else (response.finish_reason or "stop")
    payload: dict[str, Any] = {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": _usage_dict(response),
    }
    if fusion is not None:
        payload["fusion"] = fusion
    return payload


def _provider_error_response(exc: ProviderCallError) -> JSONResponse:
    """Map a classified egress failure onto an OpenAI-style error body.

    The taxonomy ``category`` (and ``retry_after``) is surfaced verbatim so a
    client - or the WS5 failover layer reading this response - can branch on it
    without re-parsing the upstream provider error.
    """
    body: dict[str, Any] = {
        "message": str(exc),
        "type": "provider_error",
        "code": exc.category,
        # ``error_category`` is the canonical machine-readable failover signal
        # the Node gateway (WS5) branches on without re-parsing provider text;
        # ``category``/``code`` are kept as aliases for existing readers.
        "error_category": exc.category,
        "category": exc.category,
        "provider": exc.provider,
    }
    if exc.retry_after is not None:
        body["retry_after"] = exc.retry_after
    return _json_response({"error": body}, status_code=_status_for_category(exc.category))


def _status_for_category(category: ProviderErrorCategory) -> int:
    match category:
        case "transient":
            return 503
        case "quota_exhausted":
            return 429
        case "auth_permanent":
            return 401
        case "unknown":
            return 502
        case _ as unreachable:
            assert_never(unreachable)


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
