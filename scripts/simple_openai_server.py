#!/usr/bin/env python3
"""Front one model endpoint (any provider) as an OpenAI Chat Completions server.

This is the cloud analogue of ``simple_mlx_openai_server.py``: it serves a
single ``/v1/chat/completions`` endpoint backed by FusionKit's provider clients
(``build_client``), so an OpenAI/Anthropic/Google model can be consumed by any
OpenAI-compatible caller (for example, HandoffKit's per-candidate coding
harness). One process fronts exactly one model, which keeps per-model routing
trivial for the caller.

Single-threaded on purpose (one model, low volume); each request runs the async
provider client in a fresh event loop so the SDK's HTTP client is bound to the
loop that drives it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from fusionkit_core.clients import build_client
from fusionkit_core.config import ModelEndpoint, SamplingConfig
from fusionkit_core.trace import (
    TRACE_CANDIDATE_HEADER,
    TRACE_ID_HEADER,
    TRACE_SPAN_HEADER,
)
from fusionkit_core.trace import emit as trace_emit
from fusionkit_core.trace import new_span_id
from fusionkit_core.types import ChatMessage, ToolCall


def _to_chat_message(message: dict[str, Any]) -> ChatMessage:
    content = message.get("content")
    kwargs: dict[str, Any] = {
        "role": message.get("role", "user"),
        "content": content if isinstance(content, str) else "",
    }
    if message.get("tool_call_id"):
        kwargs["tool_call_id"] = message["tool_call_id"]
    tool_calls = message.get("tool_calls")
    if tool_calls:
        kwargs["tool_calls"] = [
            ToolCall(
                id=call.get("id", ""),
                name=call.get("function", {}).get("name", ""),
                arguments=call.get("function", {}).get("arguments", "{}"),
            )
            for call in tool_calls
        ]
    return ChatMessage(**kwargs)


def _to_tools(tools: Any) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted = []
    for entry in tools:
        function = entry.get("function", entry)
        converted.append(
            {
                "name": function.get("name", ""),
                "description": function.get("description", ""),
                "parameters": function.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return converted

# Provider base URLs when the operator does not pass --base-url. The OpenAI
# client appends `/v1`; the Anthropic SDK takes the root.
PROVIDER_DEFAULT_BASE_URL = {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com",
}


def make_handler(endpoint: ModelEndpoint) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "fusionkit-openai-bridge/0.1"

        def log_message(self, format: str, *args: Any) -> None:
            prefix = f"{self.address_string()} - - [{self.log_date_time_string()}] "
            print(prefix + format % args, flush=True)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path in ("/health", "/v1/health"):
                self._send_json(200, {"status": "ok", "model": endpoint.id, "provider": endpoint.provider})
                return
            if self.path == "/v1/models":
                self._send_json(
                    200,
                    {
                        "object": "list",
                        "data": [{"id": endpoint.id, "object": "model", "owned_by": endpoint.provider}],
                    },
                )
                return
            self._send_json(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:
            if self.path != "/v1/chat/completions":
                self._send_json(404, {"error": {"message": "not found"}})
                return
            trace_id = self.headers.get(TRACE_ID_HEADER)
            candidate_id = self.headers.get(TRACE_CANDIDATE_HEADER)
            parent_span = self.headers.get(TRACE_SPAN_HEADER)
            call_span = new_span_id()
            try:
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                messages = [_to_chat_message(message) for message in (request.get("messages") or [])]
                tools = _to_tools(request.get("tools"))
                tool_choice = request.get("tool_choice")
                sampling = SamplingConfig(
                    temperature=float(request.get("temperature", 0.2) or 0.2),
                    top_p=float(request.get("top_p", 0.95) or 0.95),
                    max_tokens=int(request.get("max_tokens", 1024) or 1024),
                )
                trace_emit(
                    component="panel-model",
                    event_type="model.call.started",
                    trace_id=trace_id,
                    span_id=call_span,
                    parent_span_id=parent_span,
                    candidate_id=candidate_id,
                    model_id=endpoint.id,
                    payload={
                        "model": endpoint.model,
                        "provider": endpoint.provider,
                        "message_count": len(messages),
                        "tool_count": len(tools) if tools else 0,
                    },
                )

                async def run() -> Any:
                    client = build_client(endpoint)
                    return await client.chat(
                        messages,
                        sampling,
                        tools=tools,
                        tool_choice=tool_choice if isinstance(tool_choice, str) else None,
                    )

                started = time.perf_counter()
                response = asyncio.run(run())
                latency_s = time.perf_counter() - started
                trace_emit(
                    component="panel-model",
                    event_type="model.call.finished",
                    trace_id=trace_id,
                    span_id=call_span,
                    parent_span_id=parent_span,
                    candidate_id=candidate_id,
                    model_id=endpoint.id,
                    payload={
                        "model": endpoint.model,
                        "provider": endpoint.provider,
                        "latency_s": round(latency_s, 3),
                        "finish_reason": "tool_calls" if response.tool_calls else (response.finish_reason or "stop"),
                        "tool_call_count": len(response.tool_calls),
                        "content_preview": (response.content or "")[:400],
                        "usage": {
                            "prompt_tokens": response.usage.prompt_tokens,
                            "completion_tokens": response.usage.completion_tokens,
                            "total_tokens": response.usage.total_tokens,
                        },
                    },
                )
                print(
                    json.dumps(
                        {
                            "event": "chat_completion",
                            "model": endpoint.id,
                            "provider": endpoint.provider,
                            "latency_s": round(latency_s, 3),
                        }
                    ),
                    flush=True,
                )
                message_body: dict[str, Any] = {"role": "assistant", "content": response.content}
                if response.tool_calls:
                    message_body["tool_calls"] = [
                        {
                            "id": call.id or f"call_{uuid.uuid4().hex[:8]}",
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.arguments},
                        }
                        for call in response.tool_calls
                    ]
                finish_reason = "tool_calls" if response.tool_calls else (response.finish_reason or "stop")
                self._send_json(
                    200,
                    {
                        "id": f"chatcmpl-{uuid.uuid4()}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": endpoint.model,
                        "choices": [
                            {
                                "index": 0,
                                "message": message_body,
                                "finish_reason": finish_reason,
                            }
                        ],
                        "usage": {
                            "prompt_tokens": response.usage.prompt_tokens,
                            "completion_tokens": response.usage.completion_tokens,
                            "total_tokens": response.usage.total_tokens,
                        },
                    },
                )
            except Exception as exc:  # noqa: BLE001 - surface as an OpenAI error body
                traceback.print_exc()
                trace_emit(
                    component="panel-model",
                    event_type="model.call.finished",
                    trace_id=trace_id,
                    span_id=call_span,
                    parent_span_id=parent_span,
                    candidate_id=candidate_id,
                    model_id=endpoint.id,
                    payload={
                        "model": endpoint.model,
                        "provider": endpoint.provider,
                        "error": str(exc),
                        "error_type": exc.__class__.__name__,
                    },
                )
                self._send_json(
                    500,
                    {"error": {"message": str(exc), "type": exc.__class__.__name__}},
                )

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True, help="endpoint id exposed via /v1/models")
    parser.add_argument("--model", required=True, help="provider model name (e.g. gpt-5.5)")
    parser.add_argument(
        "--provider",
        default="openai",
        choices=["openai", "anthropic", "google", "openai-compatible", "mlx-lm", "custom"],
    )
    parser.add_argument("--base-url", default=None, help="override the provider base URL")
    parser.add_argument("--api-key-env", default=None, help="env var holding the API key")
    parser.add_argument("--timeout-s", type=float, default=120.0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    base_url = args.base_url or PROVIDER_DEFAULT_BASE_URL.get(args.provider, "http://127.0.0.1")
    endpoint = ModelEndpoint(
        id=args.id,
        model=args.model,
        base_url=base_url,
        provider=args.provider,
        api_key_env=args.api_key_env,
        timeout_s=args.timeout_s,
    )
    print(
        json.dumps({"event": "starting", "id": args.id, "provider": args.provider, "model": args.model}),
        flush=True,
    )
    server = HTTPServer((args.host, args.port), make_handler(endpoint))
    print(json.dumps({"event": "listening", "host": args.host, "port": args.port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
