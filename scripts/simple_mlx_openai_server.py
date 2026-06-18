#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import mlx.core as mx  # type: ignore[import-not-found]
from mlx_lm import generate, load  # type: ignore[import-not-found]
from mlx_lm.sample_utils import make_sampler  # type: ignore[import-not-found]

try:  # Trace emission is optional: this server may run in an MLX-only venv.
    from fusionkit_core.trace import (
        TRACE_CANDIDATE_HEADER,
        TRACE_ID_HEADER,
        TRACE_SPAN_HEADER,
    )
    from fusionkit_core.trace import emit as trace_emit
    from fusionkit_core.trace import new_span_id
except Exception:  # noqa: BLE001 - degrade gracefully without fusionkit_core
    TRACE_CANDIDATE_HEADER = "x-fusion-candidate-id"
    TRACE_ID_HEADER = "x-fusion-trace-id"
    TRACE_SPAN_HEADER = "x-fusion-span-id"

    def trace_emit(**_kwargs: Any) -> None:
        return None

    def new_span_id() -> str:
        return f"span_{uuid.uuid4().hex[:12]}"


def build_prompt(tokenizer: Any, messages: list[dict[str, str]]) -> tuple[str | list[int], int]:
    if getattr(tokenizer, "chat_template", None) is not None:
        try:
            text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        tokens = tokenizer.encode(text, add_special_tokens=False)
        return tokens, len(tokens)

    text = "\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages)
    text += "\nassistant:"
    tokens = tokenizer.encode(text)
    return tokens, len(tokens)


def make_handler(model_id: str, model: Any, tokenizer: Any) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "simple-mlx-openai/0.1"

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
                self._send_json(200, {"status": "ok", "model": model_id})
                return
            if self.path == "/v1/models":
                self._send_json(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": model_id,
                                "object": "model",
                                "created": int(time.time()),
                                "owned_by": "local-mlx",
                            }
                        ],
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
                messages = request.get("messages") or []
                max_tokens = int(request.get("max_tokens") or 128)
                max_allowed_tokens = int(os.environ.get("SIMPLE_MLX_MAX_TOKENS", "160"))
                max_tokens = max(1, min(max_tokens, max_allowed_tokens))
                raw_temperature = request.get("temperature")
                raw_top_p = request.get("top_p")
                temperature = float(raw_temperature if raw_temperature is not None else 0.2)
                top_p = float(raw_top_p if raw_top_p is not None else 0.95)
                trace_emit(
                    component="panel-model",
                    event_type="model.call.started",
                    trace_id=trace_id,
                    span_id=call_span,
                    parent_span_id=parent_span,
                    candidate_id=candidate_id,
                    model_id=model_id,
                    payload={"model": model_id, "provider": "local-mlx", "message_count": len(messages)},
                )

                prompt, prompt_tokens = build_prompt(tokenizer, messages)
                sampler = make_sampler(temperature, top_p)
                started = time.perf_counter()
                text = generate(
                    model,
                    tokenizer,
                    prompt,
                    max_tokens=max_tokens,
                    sampler=sampler,
                    verbose=False,
                )
                mx.synchronize()
                mx.clear_cache()
                latency_s = time.perf_counter() - started
                completion_tokens = len(tokenizer.encode(text)) if text else 0
                trace_emit(
                    component="panel-model",
                    event_type="model.call.finished",
                    trace_id=trace_id,
                    span_id=call_span,
                    parent_span_id=parent_span,
                    candidate_id=candidate_id,
                    model_id=model_id,
                    payload={
                        "model": model_id,
                        "provider": "local-mlx",
                        "latency_s": round(latency_s, 3),
                        "finish_reason": "length" if completion_tokens >= max_tokens else "stop",
                        "content_preview": (text or "")[:400],
                        "usage": {
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "total_tokens": prompt_tokens + completion_tokens,
                        },
                    },
                )
                print(
                    json.dumps(
                        {
                            "event": "chat_completion",
                            "model": model_id,
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "latency_s": round(latency_s, 3),
                        }
                    ),
                    flush=True,
                )
                self._send_json(
                    200,
                    {
                        "id": f"chatcmpl-{uuid.uuid4()}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": model_id,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": text},
                                "finish_reason": (
                                    "length" if completion_tokens >= max_tokens else "stop"
                                ),
                            }
                        ],
                        "usage": {
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "total_tokens": prompt_tokens + completion_tokens,
                        },
                    },
                )
            except Exception as exc:
                traceback.print_exc()
                self._send_json(
                    500,
                    {"error": {"message": str(exc), "type": exc.__class__.__name__}},
                )

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    print(json.dumps({"event": "loading", "model": args.model}), flush=True)
    model, tokenizer = load(args.model)
    mx.eval(model.parameters())
    print(json.dumps({"event": "loaded", "model": args.model, "port": args.port}), flush=True)
    server = HTTPServer((args.host, args.port), make_handler(args.model, model, tokenizer))
    print(json.dumps({"event": "listening", "host": args.host, "port": args.port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
