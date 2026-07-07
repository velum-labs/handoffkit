from __future__ import annotations

import json
import logging
import os
import time
import traceback
import uuid
from collections.abc import AsyncIterator
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any, assert_never, cast, get_args

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import (
    ChatClient,
    ProviderCallError,
    ProviderErrorCategory,
    build_clients,
)
from fusionkit_core.config import (
    FusionConfig,
    FusionMode,
    PromptOverrides,
    ProviderKind,
    SamplingConfig,
    model_sampling_defaults,
)
from fusionkit_core.contracts import (
    FusionRunRequestV1,
    TrajectoryV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult, sum_usages
from fusionkit_core.kernel import FusionKernel
from fusionkit_core.producers import PanelExhaustedError, trajectory_from_contract
from fusionkit_core.registry import (
    FUSION_DEFAULT_ALIAS,
    FUSION_MODEL_ALIASES,
    fusion_mode_for_model,
)
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
from fusionkit_core.trace import context_from_headers
from fusionkit_core.types import (
    ChatMessage,
    ModelResponse,
    PanelMode,
    ProviderCost,
    StreamChunk,
    ToolCall,
    Usage,
)
from pydantic import BaseModel, Field, ValidationError

from fusionkit_server.cursor_endpoint import translate_cursor_request

logger = logging.getLogger(__name__)


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
    model: str = FUSION_DEFAULT_ALIAS
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

    model: str = FUSION_DEFAULT_ALIAS
    # Raw OpenAI chat messages (assistant tool_calls are nested under `function`,
    # tool results carry `tool_call_id`, content may be a parts array); normalized
    # to FusionKit ChatMessage in the handler.
    messages: list[dict[str, Any]]
    trajectories: list[TrajectoryInput] = Field(default_factory=list)
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    judge_model: str | None = None
    synthesizer_model: str | None = None
    # Per-request system-prompt overrides (a named ensemble's committed
    # prompts). Fields win per key; unset falls back to the config overrides.
    prompts: PromptOverrides | None = None
    # "step" = candidates are receding-horizon next-step proposals (finite-k
    # panels): the judge selects and the synthesizer adopts one candidate's
    # tool-call batch verbatim or answers in text. Absent = "trajectory"
    # (today's behavior), so older gateways keep working unchanged.
    panel_mode: PanelMode = "trajectory"
    stream: bool = False


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
    app = FastAPI(title="fusionkit", version=_package_version())
    model_clients = clients or build_clients(config)
    engine = FusionEngine(config=config, clients=model_clients)
    native_runs = run_manager or _create_run_manager(engine, run_store_path)
    kernel = FusionKernel(engine, native_runs)

    # An opaque token the spawning CLI passes down so its discover-or-spawn
    # health probe can tell "the exact router I would start" apart from a
    # sibling with the same endpoint ids but different prompts/keys/sampling.
    identity = os.environ.get("FUSIONKIT_ROUTER_IDENTITY", "")

    @app.get("/health")
    async def health() -> dict[str, str]:
        payload = {"status": "ok"}
        if identity:
            payload["identity"] = identity
        return payload

    def _models_payload() -> dict[str, Any]:
        data: list[dict[str, Any]] = [
            {"id": alias, "object": "model"} for alias in FUSION_MODEL_ALIASES
        ]
        data.extend(
            {"id": endpoint.id, "object": "model", "owned_by": endpoint.provider}
            for endpoint in config.endpoints
        )
        return {"object": "list", "data": data}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return _models_payload()

    @app.get("/v1/cursor/models")
    async def cursor_models() -> dict[str, Any]:
        # Cursor may probe the models list relative to its BYOK base URL
        # (`.../v1/cursor`); mirror /v1/models there.
        return _models_payload()

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

    async def _handle_chat_completions(
        request: FusionRequest,
        *,
        record_run: bool = False,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        # Per-model passthrough: when `model` names a configured endpoint, call
        # that model directly (no fusion run) so a single `fusionkit serve` can
        # front every panel model by id for an external coding harness. The
        # reserved `fusionkit/{heuristic,panel,single,self}` names keep the fusion
        # path below.
        if _is_endpoint_model(config, request.model):
            return await _passthrough_chat(kernel, config, request)
        # Real SSE streaming on the fused path: the candidate trajectories are
        # generated, then the synthesizer turn streams tokens straight through
        # (no buffer-then-rechunk).
        if request.stream:
            stream = kernel.run_stream(
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
            return await _fusion_tool_step(kernel, config, request)
        if record_run:
            resolved = await _resolve_native_chat(kernel, request, config)
            if isinstance(resolved, JSONResponse):
                return resolved
            inspection, metadata = resolved
            return _openai_chat_response(request.model, inspection, metadata)
        return await _lightweight_fusion_chat(kernel, config, request)

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(
        request: FusionRequest,
        http_request: Request,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        record_run = http_request.headers.get("x-fusionkit-record") == "1"
        return await _handle_chat_completions(request, record_run=record_run)

    @app.post("/v1/cursor/chat/completions", response_model=None)
    async def cursor_chat_completions(
        raw_request: Request,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        # Cursor's BYOK base-URL override POSTs a Responses-API-shaped body to
        # `{base_url}/chat/completions` while expecting Chat Completions back
        # (a known Cursor hybrid). The body is parsed raw — FastAPI validating
        # it as a FusionRequest would 422 on the hybrid shape — translated via
        # `translate_cursor_request`, then delegated to the exact code path
        # the plain /v1/chat/completions route uses. Plain Chat Completions
        # bodies (Cursor Ask mode) pass through untranslated.
        try:
            body = await raw_request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return _openai_error_response(
                "invalid_json", "request body must be a JSON object", status_code=400
            )
        if not isinstance(body, dict) or ("messages" not in body and "input" not in body):
            return _openai_error_response(
                "invalid_request",
                "request body must include either 'messages' or 'input'",
                status_code=400,
            )
        try:
            request = FusionRequest.model_validate(translate_cursor_request(body))
        except ValidationError:
            # The pydantic error detail can echo request fragments; keep the
            # response body generic and log the specifics server-side.
            logger.warning("cursor request failed validation", exc_info=True)
            return _openai_error_response(
                "invalid_request",
                "request body could not be validated as a chat completion request",
                status_code=400,
            )
        return await _handle_chat_completions(
            request,
            record_run=raw_request.headers.get("x-fusionkit-record") == "1",
        )

    @app.post("/v1/fusion/trajectories:fuse", response_model=None)
    async def fuse_trajectories(
        request: FuseTrajectoriesRequest,
        http_request: Request,
    ) -> dict[str, Any] | JSONResponse | StreamingResponse:
        judge_model = request.judge_model or config.resolved_judge_model
        synthesizer_model = request.synthesizer_model or config.resolved_synthesizer_model
        for required_model in (judge_model, synthesizer_model):
            try:
                kernel.client(required_model)
            except KeyError:
                # Name the model from request/config data rather than echoing
                # the exception text into the response body.
                return _openai_error_response(
                    "unknown_model",
                    f"Unknown model endpoint {required_model!r}.",
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
        trace = context_from_headers(dict(http_request.headers))
        # Real streaming: the synthesizer turn streams tokens; the fused
        # trajectory metadata rides on the terminal SSE chunk.
        if request.stream:
            stream = kernel.fuse_trajectories_stream(
                messages,
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
                messages,
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
        except ProviderCallError as exc:
            return _provider_error_response(exc)
        except Exception:  # noqa: BLE001 - surface as an OpenAI-style error body
            traceback.print_exc()
            return _openai_error_response(
                "internal_error",
                "fusion step failed; see the server logs for details",
                status_code=502,
            )
        return _openai_step_response(
            request.model,
            result.response,
            _fusion_extension(result),
            usage=_fuse_step_usage(result),
            provider_cost=result.turn_provider_cost(),
        )

    return app


def _is_endpoint_model(config: FusionConfig, model: str) -> bool:
    try:
        config.endpoint_for(model)
        return True
    except KeyError:
        return False


async def _passthrough_chat(
    kernel: FusionKernel,
    config: FusionConfig,
    request: FusionRequest,
) -> dict[str, Any] | JSONResponse | StreamingResponse:
    """Call a single configured endpoint directly, bypassing fusion.

    This is the multi-model analogue of `serve-endpoint`: one server fronts every
    endpoint in the config, routed by the request's `model` (the endpoint id), so
    an OpenAI-compatible caller (e.g. a per-candidate coding harness) can drive any
    panel model — including its tool-call loop — through the same base URL.
    """
    sampling = _passthrough_sampling(config, request)
    tools = _normalize_tools(request.tools)
    tool_choice = _normalize_tool_choice(request.tool_choice)
    if request.stream:
        # Real passthrough streaming straight from the provider's stream_chat.
        stream = kernel.stream_passthrough(
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
        response = await kernel.passthrough_chat(
            request.model,
            request.messages,
            sampling,
            tools=tools,
            tool_choice=tool_choice,
        )
    except ProviderCallError as exc:
        return _provider_error_response(exc)
    except Exception:  # noqa: BLE001 - surface as an OpenAI-style error body
        traceback.print_exc()
        return _openai_error_response(
            "internal_error",
            "passthrough chat failed; see the server logs for details",
            status_code=502,
        )
    return _openai_step_response(request.model, response)


async def _lightweight_fusion_chat(
    kernel: FusionKernel,
    config: FusionConfig,
    request: FusionRequest,
) -> dict[str, Any] | JSONResponse:
    """Non-streaming fused chat without event-sourced run recording."""
    try:
        result = await kernel.run_step(
            request.messages,
            mode=_mode_from_request(request),
            sampling=_request_sampling(config, request),
            panel_models=request.fusion.panel_models,
            sample_count=request.fusion.sample_count,
        )
    except ProviderCallError as exc:
        return _provider_error_response(exc)
    except PanelExhaustedError:
        traceback.print_exc()
        return _openai_error_response(
            "all_models_failed",
            "fusion step failed: every panel model failed; see the server logs for details",
            status_code=502,
        )
    except Exception:  # noqa: BLE001 - surface as an OpenAI-style error body
        traceback.print_exc()
        return _openai_error_response(
            "internal_error", "fusion step failed; see the server logs for details", status_code=502
        )
    return _openai_step_response(
        request.model,
        result.response,
        _fusion_extension(result),
        usage=_fuse_step_usage(result),
        provider_cost=result.turn_provider_cost(),
        fusionkit=_lightweight_fusion_metadata(result),
    )


async def _fusion_tool_step(
    kernel: FusionKernel,
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
        result = await kernel.run_step(
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
    except PanelExhaustedError:
        # The aggregated per-model error text embeds upstream provider
        # messages; log it server-side and keep the response body generic.
        traceback.print_exc()
        return _openai_error_response(
            "all_models_failed",
            "fusion step failed: every panel model failed; see the server logs for details",
            status_code=502,
        )
    except Exception:  # noqa: BLE001 - surface as an OpenAI-style error body
        traceback.print_exc()
        return _openai_error_response(
            "internal_error", "fusion step failed; see the server logs for details", status_code=502
        )
    return _openai_step_response(
        request.model,
        result.response,
        _fusion_extension(result),
        usage=_fuse_step_usage(result),
        provider_cost=result.turn_provider_cost(),
    )


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


def _passthrough_sampling(config: FusionConfig, request: FusionRequest) -> SamplingConfig:
    """Request sampling for a passthrough call, with per-model defaults.

    Precedence: an explicit request value wins, then an operator-pinned value in
    the config's ``sampling`` section, then the model-family default (qwen /
    kimi-k2 anti-repetition tuning), then the generic default.
    """
    sampling = _request_sampling(config, request)
    try:
        endpoint = config.endpoint_for(request.model)
    except KeyError:
        return sampling
    request_values = {"temperature": request.temperature, "top_p": request.top_p}
    update = {
        key: value
        for key, value in model_sampling_defaults(endpoint.model).items()
        if request_values.get(key) is None and key not in config.sampling.model_fields_set
    }
    return sampling.model_copy(update=update) if update else sampling


async def _resolve_native_chat(
    kernel: FusionKernel,
    request: FusionRequest,
    config: FusionConfig,
) -> tuple[RunInspection, dict[str, Any]] | JSONResponse:
    run_request = _fusion_request_to_run_request(request, config)
    result = await kernel.create_and_run(run_request)
    if isinstance(result, CreateRunResult):
        if result.idempotency_outcome == "conflict":
            return _openai_native_error_response(result.terminal_error, status_code=409)
        if result.run_id is None:
            return _openai_error_response(
                "run_not_available",
                "Native run did not return a run id.",
                status_code=500,
            )
        result = kernel.inspect_run(result.run_id)
    if result.state != "completed" or result.final_output is None:
        return _openai_native_error_response(result.terminal_error, status_code=500)
    return result, _chat_fusion_metadata(result)


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
            if item.reasoning_delta:
                # The judge's analysis rides the reasoning channel ahead of the
                # answer; coding agents render it in their native thinking UI.
                yield chunk({"reasoning_content": item.reasoning_delta}, None, None)
            if item.model_reasoning_delta:
                # The upstream model's own reasoning tokens (local MLX / vLLM
                # style). Re-emitted on `reasoning` — the token-stream field —
                # so downstream translators accumulate rather than treating
                # every token as a narration beat.
                yield chunk({"reasoning": item.model_reasoning_delta}, None, None)
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
    # Carry the fuse step's token usage (judge + synthesizer combined) on the
    # terminal chunk so a streaming client (and the Node gateway's cost meter,
    # which reads `usage` off the SSE tail) can account a fused stream's cost —
    # mirroring the non-streaming `_openai_step_response` body.
    if final_result is not None:
        extra["usage"] = _usage_payload(final_result.turn_usage())
        step_cost = final_result.turn_provider_cost()
        if step_cost is not None:
            extra["provider_cost"] = step_cost.model_dump(mode="json", exclude_none=True)
    elif response is not None:
        extra["usage"] = _usage_payload(response.usage)
        if response.provider_cost is not None:
            extra["provider_cost"] = response.provider_cost.model_dump(
                mode="json", exclude_none=True
            )
    yield chunk({}, finish, extra or None)
    yield "data: [DONE]\n\n"


def _sse_error_event(exc: BaseException) -> str:
    if isinstance(exc, ProviderCallError):
        # Mirror the non-streaming error body so a mid-stream failure carries
        # the same canonical ``error_category`` failover signal (WS5).
        body: dict[str, Any] = _provider_error_body(exc)
    else:
        # Unclassified exceptions must not leak internals (messages can embed
        # paths, config, or stack fragments); the full traceback is logged
        # server-side where the stream is caught.
        body = {
            "message": "internal error during streaming; see the server logs for details",
            "type": "internal_error",
            "code": "internal_error",
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


def _lightweight_fusion_metadata(result: FuseResult) -> dict[str, Any]:
    return {"trajectory_count": result.panel_trajectory_count}


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
    return cast(FusionMode, fusion_mode_for_model(request.model))


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


# `type` values that mark a wire shape or a choice mode, never a tool identity.
_NON_TOOL_TYPES = frozenset({"function", "custom", "auto", "none", "required", "any", "tool"})


def _resolved_tool_name(entry: dict[str, Any], function: dict[str, Any]) -> str:
    """The provider-facing name for a tool definition.

    Named tools keep their name. A *typed* nameless tool (e.g. an OpenAI
    Responses `{type: "tool_search", ...}` / `{type: "web_search", ...}` entry)
    is projected under its ``type``: the caller executes those tools client-side
    and dispatches the returned tool call by that same name, so the projection
    round-trips losslessly. Shape/mode markers (``function``, ``auto``, ...)
    are never treated as tool identities.
    """
    name = function.get("name", "")
    if isinstance(name, str) and name:
        return name
    kind = entry.get("type", "") if isinstance(entry, dict) else ""
    if isinstance(kind, str) and kind and kind not in _NON_TOOL_TYPES:
        return kind
    return ""


def _normalize_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Accept OpenAI-nested ({type:function, function:{...}}), flat, or typed
    nameless tool defs and return the flat {name, description, parameters}
    shape FusionKit's clients expect (typed tools projected under their type)."""
    if not tools:
        return None
    normalized: list[dict[str, Any]] = []
    for entry in tools:
        function = (
            entry.get("function") if isinstance(entry, dict) and "function" in entry else entry
        )
        if not isinstance(function, dict):
            continue
        name = _resolved_tool_name(entry, function)
        # Skip only tools with no resolvable identity at all: nothing for the
        # model to call and nothing the caller could dispatch back.
        if not name:
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
        name = (
            _resolved_tool_name(choice, function) if isinstance(function, dict) else ""
        )
        if name:
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


def _fuse_step_usage(result: FuseResult) -> Usage:
    usages: list[Usage] = []
    if result.panel_usage is not None:
        usages.append(result.panel_usage)
    usages.append(result.turn_usage())
    return sum_usages(usages)


def _usage_payload(usage: Usage) -> dict[str, Any]:
    return {
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
    }


def _fusion_extension(result: FuseResult) -> dict[str, Any] | None:
    """The ``fusion`` extension carried on a fuse response.

    On the terminal step the fused output is a trajectory whose ``synthesis``
    holds the fusion result (decision/selected/rationale/metrics). A
    non-terminal step (the synthesizer committed a tool-call batch the caller
    will execute) carries the judge's ``best_trajectory`` instead, so the
    gateway can attribute the adopted proposal between rounds (narration's
    "last round the judge picked X" opener)."""
    trajectory = result.trajectory
    if not result.terminal or trajectory is None:
        best = result.analysis.best_trajectory if result.analysis is not None else None
        if best:
            return {"analysis": {"best_trajectory": best}}
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
    *,
    usage: Usage | None = None,
    provider_cost: ProviderCost | None = None,
    fusionkit: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": response.content or ""}
    if response.reasoning:
        # Out-of-band reasoning (local MLX / vLLM-style upstreams) surfaces on
        # the de-facto ``reasoning_content`` field coding agents understand.
        message["reasoning_content"] = response.reasoning
    tool_calls = _tool_calls_payload(response)
    if tool_calls:
        message["tool_calls"] = tool_calls
    finish_reason = "tool_calls" if tool_calls else (response.finish_reason or "stop")
    resolved_cost = provider_cost if provider_cost is not None else response.provider_cost
    payload: dict[str, Any] = {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": _usage_payload(usage if usage is not None else response.usage),
    }
    if resolved_cost is not None:
        payload["provider_cost"] = resolved_cost.model_dump(mode="json", exclude_none=True)
    if fusion is not None:
        payload["fusion"] = fusion
    if fusionkit is not None:
        payload["fusionkit"] = fusionkit
    return payload


# Closed vocabularies for laundering classified-error fields into response
# bodies: values come from these literal maps, never from the exception object,
# so upstream exception text cannot ride along into a client-visible payload.
_SAFE_CATEGORIES: dict[str, ProviderErrorCategory] = {
    name: name for name in get_args(ProviderErrorCategory)
}
_SAFE_PROVIDERS: dict[str, str] = {name: name for name in get_args(ProviderKind)}


def _safe_category(category: object) -> ProviderErrorCategory:
    return _SAFE_CATEGORIES.get(str(category), "unknown")


def _provider_error_body(exc: ProviderCallError) -> dict[str, Any]:
    """Build the OpenAI-style error body for a classified egress failure.

    The taxonomy ``category`` (and ``retry_after``) is surfaced so a client -
    or the WS5 failover layer reading this response - can branch on it without
    re-parsing the upstream provider error. The upstream provider's message is
    logged server-side rather than echoed to the client: provider error bodies
    can embed request excerpts and infrastructure details.
    """
    category = _safe_category(exc.category)
    provider = _SAFE_PROVIDERS.get(str(exc.provider), "custom")
    logger.warning("provider call failed (%s/%s): %s", provider, category, exc)
    body: dict[str, Any] = {
        "message": (
            f"{provider} call failed ({category}); see the server logs for the provider's message"
        ),
        "type": "provider_error",
        "code": category,
        # ``error_category`` is the canonical machine-readable failover signal
        # the Node gateway (WS5) branches on without re-parsing provider text;
        # ``category``/``code`` are kept as aliases for existing readers.
        "error_category": category,
        "category": category,
        "provider": provider,
    }
    retry_after = exc.retry_after
    if isinstance(retry_after, int | float):
        body["retry_after"] = float(retry_after)
    return body


def _provider_error_response(exc: ProviderCallError) -> JSONResponse:
    """Map a classified egress failure onto an OpenAI-style error body."""
    body = _provider_error_body(exc)
    return _json_response(
        {"error": body}, status_code=_status_for_category(_safe_category(exc.category))
    )


def _status_for_category(category: ProviderErrorCategory) -> int:
    match category:
        case "transient":
            return 503
        case "quota_exhausted":
            return 429
        case "auth_permanent":
            return 401
        case "context_overflow":
            # The payload as-is can never succeed; mirror the upstream 400.
            return 400
        case "unknown":
            return 502
        case _ as unreachable:
            assert_never(unreachable)


def _openai_chat_response(
    model: str, inspection: RunInspection, metadata: dict[str, Any]
) -> dict[str, Any]:
    # Real metering on the plain non-streaming path: the run ledger already
    # records every model call (panel + judge + synthesizer), so the response
    # carries their summed usage rather than a fabricated null block.
    usage = inspection.usage
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
                    "content": inspection.final_output or "",
                },
            }
        ],
        "usage": {
            "prompt_tokens": usage.prompt_tokens if usage is not None else None,
            "completion_tokens": usage.completion_tokens if usage is not None else None,
            "total_tokens": usage.total_tokens if usage is not None else None,
        },
        "fusionkit": metadata,
    }
