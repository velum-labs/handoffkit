from __future__ import annotations

import json
import logging
import os
import time
import traceback
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import ChatClient, build_clients
from fusionkit_core.config import FusionConfig, PromptOverrides, SamplingConfig
from fusionkit_core.contracts import (
    ContractUsage,
    FusionRunRequestV1,
    Status,
    TrajectoryV1,
    contract_metadata,
)
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.judge import FuseResult
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
    Trajectory,
    Usage,
)
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

logger = logging.getLogger(__name__)


class TrajectoryItemInput(BaseModel):
    index: int
    type: Literal[
        "message",
        "reasoning",
        "function_call",
        "function_call_output",
    ]
    text: str | None = None
    call_id: str | None = None
    name: str | None = None
    arguments: str | None = None
    is_error: bool | None = None
    output_hash: str | None = None

    @field_validator("type", mode="before")
    @classmethod
    def _normalize_legacy_output_type(cls, value: object) -> object:
        return "message" if value == "output" else value


class TrajectoryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trajectory_id: str
    model_id: str
    status: Status
    items: list[TrajectoryItemInput] = Field(
        default_factory=list,
        validation_alias=AliasChoices("items", "steps"),
    )
    final_output: str
    candidate_id: str | None = None
    model: str | None = None
    harness_kind: str | None = None
    diff: str | None = None
    usage: ContractUsage | None = None
    patch_artifact: dict[str, Any] | None = None
    synthesis: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    verification: dict[str, Any] | None = None
    end_reason: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class FuseTrajectoriesRequest(BaseModel):
    """One internal fusion step over externally produced trajectories."""

    model_config = ConfigDict(extra="forbid")

    model: str = FUSION_DEFAULT_ALIAS
    messages: list[ChatMessage] = Field(min_length=1)
    trajectories: list[TrajectoryInput] = Field(default_factory=list)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    max_tokens: int | None = Field(default=None, ge=1)
    max_completion_tokens: int | None = Field(default=None, ge=1)
    seed: int | None = None
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    parallel_tool_calls: bool | None = None
    judge_model: str | None = None
    synthesizer_model: str | None = None
    prompts: PromptOverrides | None = None
    panel_mode: PanelMode = "trajectory"
    include_evidence: bool = False
    reasoning: dict[str, Any] | None = None
    provider: dict[str, Any] | None = None
    usage: dict[str, Any] | None = None
    stream: bool = False

    @model_validator(mode="after")
    def _require_successful_trajectory(self) -> FuseTrajectoriesRequest:
        if (
            self.max_tokens is not None
            and self.max_completion_tokens is not None
            and self.max_tokens != self.max_completion_tokens
        ):
            raise ValueError(
                "max_tokens and max_completion_tokens must match when both are supplied"
            )
        if self.max_tokens is None and self.max_completion_tokens is not None:
            self.max_tokens = self.max_completion_tokens
        if not any(trajectory.status == "succeeded" for trajectory in self.trajectories):
            raise ValueError("at least one succeeded trajectory is required")
        return self


def _trajectory_contract_payload(trajectory: TrajectoryInput) -> dict[str, Any]:
    payload = trajectory.model_dump(
        exclude={"verification", "end_reason"},
        exclude_none=True,
    )
    compatibility = {
        key: value
        for key, value in {
            "verification": trajectory.verification,
            "end_reason": trajectory.end_reason,
        }.items()
        if value is not None
    }
    if compatibility:
        payload["metadata"] = {
            **(trajectory.metadata or {}),
            **compatibility,
        }
    return payload


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
                        **_trajectory_contract_payload(trajectory),
                    }
                )
            )
            for trajectory in request.trajectories
        ]
        tools = _normalize_tools(request.tools)
        tool_choice = _normalize_tool_choice(request.tool_choice)
        request_extra = _request_extra(request)
        trace = context_from_headers(dict(http_request.headers))
        if request.stream:
            stream = kernel.fuse_trajectories_stream(
                request.messages,
                trajectories,
                judge_model=judge_model,
                synthesizer_model=synthesizer_model,
                sampling=_request_sampling(config, request),
                tools=tools,
                tool_choice=tool_choice,
                prompts=request.prompts,
                panel_mode=request.panel_mode,
                trace=trace,
                request_extra=request_extra,
            )
            return StreamingResponse(
                _fused_completion_sse(
                    request.model,
                    stream,
                    include_evidence=request.include_evidence,
                ),
                media_type="text/event-stream",
            )
        try:
            result = await kernel.fuse_trajectories(
                request.messages,
                trajectories,
                judge_model=judge_model,
                synthesizer_model=synthesizer_model,
                sampling=_request_sampling(config, request),
                tools=tools,
                tool_choice=tool_choice,
                prompts=request.prompts,
                panel_mode=request.panel_mode,
                trace=trace,
                request_extra=request_extra,
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
            _fusion_extension(result, include_evidence=request.include_evidence),
            usage=result.turn_usage(),
        )

    return app


def _request_sampling(
    config: FusionConfig,
    request: FuseTrajectoriesRequest,
) -> SamplingConfig:
    return config.sampling.model_copy(
        update={
            key: value
            for key, value in {
                "temperature": request.temperature,
                "top_p": request.top_p,
                "max_tokens": request.max_tokens,
                "seed": request.seed,
            }.items()
            if value is not None
        }
    )


def _request_extra(
    request: FuseTrajectoriesRequest,
) -> dict[str, object] | None:
    """Provider-specific controls that must survive every model-call stage."""

    extra: dict[str, object] = {
        key: value
        for key, value in {
            "provider": request.provider,
            "reasoning": request.reasoning,
            "usage": request.usage,
            "parallel_tool_calls": request.parallel_tool_calls,
        }.items()
        if value is not None
    }
    return extra or None


async def _fused_completion_sse(
    model: str,
    stream: AsyncIterator[StreamChunk | FuseResult],
    *,
    include_evidence: bool = False,
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
        fusion_extension = _fusion_extension(
            final_result,
            include_evidence=include_evidence,
        )
        if fusion_extension is not None:
            extra["fusion"] = fusion_extension
    # Carry the fuse step's token usage (judge + synthesizer combined) on the
    # terminal chunk so a streaming client (and the Node gateway's cost meter,
    # which reads `usage` off the SSE tail) can account a fused stream's cost —
    # mirroring the non-streaming `_openai_step_response` body.
    if final_result is not None:
        extra["usage"] = _usage_payload(final_result.turn_usage())
    elif response is not None:
        extra["usage"] = _usage_payload(response.usage)
    yield chunk({}, finish, extra or None)
    yield "data: [DONE]\n\n"


def _sse_error_event(exc: BaseException) -> str:
    del exc
    body = {
        "type": "sidecar_error",
        "code": "fusion_failed",
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


def _trajectory_evidence_payload(trajectory: Trajectory) -> dict[str, Any]:
    metadata_keys = (
        "latency_s",
        "usage",
        "finish_reason",
        "temperature",
        "seed",
        "generation_status",
        "error_code",
        "error_category",
        "provider",
        "status_code",
        "verification",
        "end_reason",
    )
    metadata = {
        key: trajectory.metadata[key]
        for key in metadata_keys
        if key in trajectory.metadata
    }
    raw_cost = trajectory.metadata.get("provider_cost")
    if isinstance(raw_cost, Mapping):
        metadata["provider_cost"] = {
            key: value
            for key, value in raw_cost.items()
            if key != "raw"
        }
    raw_response = trajectory.metadata.get("raw_response")
    if isinstance(raw_response, Mapping):
        response_identity = {
            key: raw_response[key]
            for key in ("id", "model", "provider")
            if key in raw_response
        }
        if response_identity:
            metadata["response"] = response_identity
    return {
        "trajectory_id": trajectory.id,
        "model_id": trajectory.model_id,
        "status": trajectory.status,
        "items": [
            item.model_dump(mode="json", exclude_none=True)
            for item in trajectory.items
        ],
        "final_output": trajectory.content,
        "metadata": metadata,
    }


def _fusion_extension(
    result: FuseResult,
    *,
    include_evidence: bool = False,
) -> dict[str, Any] | None:
    """The ``fusion`` extension carried on a fuse response.

    On the terminal step the fused output is a trajectory whose ``synthesis``
    holds the fusion result (decision/selected/rationale/metrics). A
    non-terminal step (the synthesizer committed a tool-call batch the caller
    will execute) carries the judge's ``best_trajectory`` instead, so the
    gateway can attribute the adopted proposal between rounds (narration's
    "last round the judge picked X" opener)."""
    extension: dict[str, Any] = {}
    trajectory = result.trajectory
    if not result.terminal or trajectory is None:
        best = result.analysis.best_trajectory if result.analysis is not None else None
        if best:
            extension["analysis"] = {"best_trajectory": best}
    else:
        extension["trajectory"] = {
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
    if include_evidence:
        extension["evidence_schema"] = "fusionkit.input-trajectories.v1"
        extension["input_trajectories"] = [
            _trajectory_evidence_payload(candidate)
            for candidate in result.input_trajectories
        ]
    return extension or None


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


__all__ = [
    "FuseTrajectoriesRequest",
    "TrajectoryInput",
    "TrajectoryItemInput",
    "create_app",
]
