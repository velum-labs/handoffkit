"""The provider simulator HTTP server.

A stdlib-only threaded HTTP server that speaks the OpenAI Chat Completions and
Anthropic Messages wire dialects, plus a control plane (behavior queueing /
journal / reset) under ``/__sim/*``. Stdlib on purpose: no web framework in
the test trust surface, and byte-level control of the wire (chunked SSE
pacing, deliberately truncated streams) that a framework would abstract away.

Usage (in-process)::

    with ProviderSimulator() as sim:
        sim.queue("gpt-test", Behavior(reply="hello"))
        ... point an endpoint's base_url at sim.url ...
        assert sim.journal()[0]["model"] == "gpt-test"

Usage (standalone, e.g. from the Node test suite)::

    uv run --package fusionkit-testkit fusionkit-sim --port 0
"""

from __future__ import annotations

import contextlib
import json
import re
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import parse_qs, urlsplit

from fusionkit_testkit import wire_anthropic, wire_google, wire_openai, wire_responses
from fusionkit_testkit.behaviors import Behavior, SimError

_JSON_TYPE = "application/json"
_SSE_TYPE = "text/event-stream"

# google-genai builds `{base_url}/{api_version}/models/{model}:{method}`.
_GOOGLE_ROUTE = re.compile(
    r"^/(?:v1beta|v1)/models/(?P<model>[^:]+):(?P<method>generateContent|streamGenerateContent)$"
)


class _SimulatorState:
    """Thread-safe behavior queues + request journal."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queues: dict[str, deque[Behavior]] = defaultdict(deque)
        self._journal: list[dict[str, Any]] = []
        self._default_counts: dict[str, int] = defaultdict(int)
        self._seq = 0
        self._response_seq = 0
        # OpenRouter post-response accounting: response id -> generation data
        # served on GET /v1/generation (recorded for every OpenAI-chat reply).
        self._generations: dict[str, dict[str, Any]] = {}

    def queue(self, model: str, *behaviors: Behavior) -> None:
        with self._lock:
            self._queues[model].extend(behaviors)

    def next_behavior(self, model: str, last_user_text: str) -> tuple[Behavior, str]:
        with self._lock:
            queued = self._queues.get(model)
            if queued:
                return queued.popleft(), "queued"
            self._default_counts[model] += 1
            count = self._default_counts[model]
        return (
            Behavior(reply=f"{model} default reply #{count}: {last_user_text}".strip()),
            "default",
        )

    def record(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            entry["seq"] = self._seq
            self._journal.append(entry)

    def journal(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(entry) for entry in self._journal]

    def known_models(self) -> list[str]:
        with self._lock:
            return sorted(set(self._queues) | set(self._default_counts))

    def next_response_id(self, prefix: str) -> str:
        with self._lock:
            self._response_seq += 1
            return f"{prefix}{self._response_seq}"

    def record_generation(self, response_id: str, model: str, behavior: Behavior) -> None:
        completion = behavior.resolved_completion_tokens()
        with self._lock:
            self._generations[response_id] = {
                "id": response_id,
                "model": model,
                "total_cost": behavior.provider_cost_usd,
                "provider_name": "simulated",
                "tokens_prompt": behavior.prompt_tokens,
                "tokens_completion": completion,
                "native_tokens_prompt": behavior.prompt_tokens,
                "native_tokens_completion": completion,
            }

    def generation(self, response_id: str) -> dict[str, Any] | None:
        with self._lock:
            data = self._generations.get(response_id)
            return dict(data) if data is not None else None

    def reset(self) -> None:
        with self._lock:
            self._queues.clear()
            self._journal.clear()
            self._default_counts.clear()
            self._generations.clear()
            self._seq = 0


def _last_user_text_openai(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
    return ""


def _last_user_text_anthropic(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
    return ""


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def _state(self) -> _SimulatorState:
        return cast("_SimulatorServer", self.server).state

    # -- plumbing ---------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        # Quiet by default; the journal is the observation surface.
        del format, args

    def _read_body(self) -> dict[str, Any] | None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return body if isinstance(body, dict) else None

    def _send_json(
        self, payload: dict[str, Any], status: int = 200, headers: dict[str, str] | None = None
    ) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", _JSON_TYPE)
        self.send_header("Content-Length", str(len(raw)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", _SSE_TYPE)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _write_chunk(self, data: bytes) -> None:
        self.wfile.write(f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n")

    def _end_chunks(self) -> None:
        self.wfile.write(b"0\r\n\r\n")

    def _abort_stream(self) -> None:
        """Deliberately break the stream: no terminal chunk, close the socket."""
        self.wfile.flush()
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.shutdown(1)  # SHUT_WR: the peer sees an early EOF

    # -- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path == "/health":
            self._send_json({"status": "ok", "simulator": True})
            return
        if self.path.startswith("/__sim/journal"):
            self._send_json({"entries": self._state.journal()})
            return
        parts = urlsplit(self.path)
        if parts.path == "/v1/generation":
            # OpenRouter's post-response accounting endpoint: served for every
            # OpenAI-chat response id the simulator produced.
            generation_id = parse_qs(parts.query).get("id", [""])[0]
            data = self._state.generation(generation_id)
            if data is None:
                self._send_json(
                    {"error": {"message": f"generation {generation_id!r} not found"}}, status=404
                )
                return
            self._state.record(
                {
                    "ts": time.time(),
                    "dialect": "openrouter-generation",
                    "path": self.path,
                    "model": str(data.get("model", "")),
                    "stream": False,
                    "source": "generation",
                    "kind": "reply",
                    "status": 200,
                    "auth": {
                        "authorization": self.headers.get("Authorization"),
                        "x_api_key": self.headers.get("x-api-key"),
                        "x_goog_api_key": self.headers.get("x-goog-api-key"),
                        "chatgpt_account_id": self.headers.get("chatgpt-account-id"),
                    },
                    "request": {"id": generation_id},
                    "reply_preview": "",
                    "tool_call_names": [],
                    "error_code": None,
                }
            )
            self._send_json({"data": data})
            return
        if self.path in ("/v1/models", "/models"):
            self._send_json(
                {
                    "object": "list",
                    "data": [
                        {"id": model, "object": "model"}
                        for model in self._state.known_models()
                    ],
                }
            )
            return
        self._send_json({"error": {"message": f"no route {self.path}"}}, status=404)

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        body = self._read_body()
        if body is None:
            self._send_json({"error": {"message": "invalid JSON body"}}, status=400)
            return
        path = urlsplit(self.path).path
        if path == "/__sim/behaviors":
            self._control_behaviors(body)
            return
        if path == "/__sim/reset":
            self._state.reset()
            self._send_json({"status": "reset"})
            return
        if path in ("/v1/chat/completions", "/chat/completions"):
            self._openai_chat(body)
            return
        if path in ("/v1/messages", "/messages"):
            self._anthropic_messages(body)
            return
        if path in ("/v1/responses", "/responses"):
            self._openai_responses(body)
            return
        google = _GOOGLE_ROUTE.match(path)
        if google is not None:
            self._google_generate(
                body,
                model=google.group("model"),
                stream=google.group("method") == "streamGenerateContent",
            )
            return
        self._send_json({"error": {"message": f"no route {self.path}"}}, status=404)

    # -- control plane ----------------------------------------------------

    def _control_behaviors(self, body: dict[str, Any]) -> None:
        model = body.get("model")
        behaviors = body.get("behaviors")
        if not isinstance(model, str) or not isinstance(behaviors, list):
            self._send_json(
                {"error": {"message": "expected {model: str, behaviors: [...]}"}}, status=400
            )
            return
        parsed = [Behavior.from_json(item) for item in behaviors if isinstance(item, dict)]
        self._state.queue(model, *parsed)
        self._send_json({"status": "queued", "model": model, "count": len(parsed)})

    # -- journal helper ---------------------------------------------------

    def _record(
        self,
        *,
        dialect: str,
        model: str,
        stream: bool,
        source: str,
        behavior: Behavior,
        body: dict[str, Any],
    ) -> None:
        kind = "error" if behavior.error is not None else (
            "tool_calls" if behavior.tool_calls else "reply"
        )
        self._state.record(
            {
                "ts": time.time(),
                "dialect": dialect,
                "path": self.path,
                "model": model,
                "stream": stream,
                "source": source,
                "kind": kind,
                "status": behavior.error.status if behavior.error is not None else 200,
                "auth": {
                    "authorization": self.headers.get("Authorization"),
                    "x_api_key": self.headers.get("x-api-key"),
                    "x_goog_api_key": self.headers.get("x-goog-api-key"),
                    "chatgpt_account_id": self.headers.get("chatgpt-account-id"),
                },
                "request": body,
                "reply_preview": (behavior.reply or "")[:200],
                "tool_call_names": [call.name for call in behavior.tool_calls],
                "error_code": behavior.error.code if behavior.error is not None else None,
            }
        )

    # -- shared dialect plumbing --------------------------------------------

    def _resolve(
        self, *, dialect: str, model: str, stream: bool, last_user: str, body: dict[str, Any]
    ) -> Behavior:
        """Pop the next behavior, journal the call, and apply latency injection."""
        behavior, source = self._state.next_behavior(model, last_user)
        # Realism guardrail: a real model can never call a tool the request did
        # not declare. A scripted tool_calls behavior answering a request with
        # no `tools` means the product dropped the caller's tools somewhere (or
        # the test script is wrong) — fail loudly instead of letting the
        # missing declaration pass silently.
        if behavior.tool_calls and not body.get("tools"):
            # Status 400 with no taxonomy markers classifies `unknown`: neither
            # the SDKs nor FusionKit retry it, so the violation cannot be
            # masked by a retry falling through to the echo default.
            behavior = Behavior(
                error=SimError(
                    status=400,
                    code="sim_tools_not_declared",
                    error_type="simulator_contract_error",
                    message=(
                        f"simulator: a tool_calls behavior was queued for {model!r} but the "
                        "request declared no tools — the caller's tool definitions were "
                        "dropped before reaching the provider wire"
                    ),
                )
            )
        self._record(
            dialect=dialect, model=model, stream=stream,
            source=source, behavior=behavior, body=body,
        )
        if behavior.delay_s > 0:
            time.sleep(behavior.delay_s)
        return behavior

    def _send_error(self, behavior: Behavior, error_json: dict[str, Any]) -> None:
        assert behavior.error is not None
        headers = (
            {"retry-after": str(behavior.error.retry_after)}
            if behavior.error.retry_after is not None
            else None
        )
        self._send_json(error_json, status=behavior.error.status, headers=headers)

    def _stream_sse(
        self, blocks: list[bytes], behavior: Behavior, *, done: bytes | None = None
    ) -> None:
        """Emit pre-rendered SSE blocks, honoring pacing and broken-stream injection."""
        if behavior.chunk_bytes is not None and behavior.broken_stream is None:
            self._stream_rechunked(blocks, behavior, done=done)
            return
        self._start_sse()
        cutoff = max(1, len(blocks) // 2) if behavior.broken_stream is not None else None
        for index, block in enumerate(blocks):
            if cutoff is not None and index >= cutoff:
                if behavior.broken_stream == "garbage":
                    self._write_chunk(b"data: {this is not json\n\n")
                    self.wfile.flush()
                self._abort_stream()
                return
            self._write_chunk(block)
            self.wfile.flush()
            if behavior.chunk_delay_s > 0:
                time.sleep(behavior.chunk_delay_s)
        if done is not None:
            self._write_chunk(done)
        self._end_chunks()

    def _stream_rechunked(
        self, blocks: list[bytes], behavior: Behavior, *, done: bytes | None
    ) -> None:
        """Emit the whole SSE payload re-split into fixed-size wire chunks.

        Real providers make no promise about how a stream's bytes align to
        frames: a chunk may end mid-`data:` line or mid-UTF-8-rune. Splitting
        at every ``chunk_bytes`` boundary (including inside multi-byte
        characters) proves client stream reassembly is byte-exact.
        """
        size = max(1, behavior.chunk_bytes or 1)
        payload = b"".join(blocks) + (done or b"")
        self._start_sse()
        for start in range(0, len(payload), size):
            self._write_chunk(payload[start : start + size])
            self.wfile.flush()
            if behavior.chunk_delay_s > 0:
                time.sleep(behavior.chunk_delay_s)
        self._end_chunks()

    # -- OpenAI Chat Completions -------------------------------------------

    def _openai_chat(self, body: dict[str, Any]) -> None:
        model = str(body.get("model", "unknown"))
        stream = body.get("stream") is True
        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        behavior = self._resolve(
            dialect="openai-chat", model=model, stream=stream,
            last_user=_last_user_text_openai(messages or []), body=body,
        )
        response_id = self._state.next_response_id("chatcmpl-sim")
        if behavior.error is not None:
            self._send_error(behavior, wire_openai.error_body(behavior))
            return
        self._state.record_generation(response_id, model, behavior)
        if not stream:
            self._send_json(wire_openai.completion_body(model, behavior, response_id))
            return
        stream_options = body.get("stream_options")
        include_usage = (
            isinstance(stream_options, dict) and stream_options.get("include_usage") is True
        )
        blocks = [
            f"data: {frame}\n\n".encode()
            for frame in wire_openai.stream_frames(model, behavior, response_id, include_usage)
        ]
        self._stream_sse(blocks, behavior, done=b"data: [DONE]\n\n")

    # -- Anthropic Messages -------------------------------------------------

    def _anthropic_messages(self, body: dict[str, Any]) -> None:
        model = str(body.get("model", "unknown"))
        stream = body.get("stream") is True
        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        behavior = self._resolve(
            dialect="anthropic-messages", model=model, stream=stream,
            last_user=_last_user_text_anthropic(messages or []), body=body,
        )
        message_id = f"msg_sim{int(time.time() * 1000) % 1_000_000}"
        if behavior.error is not None:
            self._send_error(behavior, wire_anthropic.error_body(behavior))
            return
        if not stream:
            self._send_json(wire_anthropic.message_body(model, behavior, message_id))
            return
        blocks = [
            f"event: {name}\ndata: {payload}\n\n".encode()
            for name, payload in wire_anthropic.stream_events(model, behavior, message_id)
        ]
        self._stream_sse(blocks, behavior)

    # -- OpenAI Responses (the codex provider dialect) -----------------------

    def _openai_responses(self, body: dict[str, Any]) -> None:
        model = str(body.get("model", "unknown"))
        # The codex client is stream-only; honor an explicit stream=false anyway.
        stream = body.get("stream") is not False
        behavior = self._resolve(
            dialect="openai-responses", model=model, stream=stream,
            last_user=wire_responses.last_user_text(body), body=body,
        )
        response_id = f"resp_sim{int(time.time() * 1000) % 1_000_000}"
        if behavior.error is not None:
            self._send_error(behavior, wire_responses.error_body(behavior))
            return
        if not stream:
            self._send_json(
                wire_responses.response_snapshot(model, behavior, response_id, status="completed")
            )
            return
        blocks = [
            f"event: {name}\ndata: {payload}\n\n".encode()
            for name, payload in wire_responses.stream_events(model, behavior, response_id)
        ]
        self._stream_sse(blocks, behavior)

    # -- Google Gemini (GenAI API) -------------------------------------------

    def _google_generate(self, body: dict[str, Any], *, model: str, stream: bool) -> None:
        behavior = self._resolve(
            dialect="google-generate", model=model, stream=stream,
            last_user=wire_google.last_user_text(body), body=body,
        )
        if behavior.error is not None:
            self._send_error(behavior, wire_google.error_body(behavior))
            return
        if not stream:
            self._send_json(wire_google.generate_content_body(behavior))
            return
        blocks = [f"data: {frame}\n\n".encode() for frame in wire_google.stream_frames(behavior)]
        self._stream_sse(blocks, behavior)


class _SimulatorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: _SimulatorState) -> None:
        super().__init__(address, _Handler)
        self.state = state


class ProviderSimulator:
    """A running provider simulator bound to a loopback port.

    Context-manager friendly; ``start()``/``stop()`` for manual lifecycles.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._requested_port = port
        self._state = _SimulatorState()
        self._server: _SimulatorServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle --------------------------------------------------------

    def start(self) -> ProviderSimulator:
        if self._server is not None:
            return self
        self._server = _SimulatorServer((self._host, self._requested_port), self._state)
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fusionkit-sim", daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    def __enter__(self) -> ProviderSimulator:
        return self.start()

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    # -- addressing -------------------------------------------------------

    @property
    def port(self) -> int:
        assert self._server is not None, "simulator is not started"
        return self._server.server_address[1]

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self.port}"

    # -- control plane (in-process) ----------------------------------------

    def queue(self, model: str, *behaviors: Behavior | str) -> None:
        """Queue behaviors for a model (FIFO). Plain strings become text replies."""
        self._state.queue(
            model,
            *(
                behavior if isinstance(behavior, Behavior) else Behavior(reply=behavior)
                for behavior in behaviors
            ),
        )

    # -- observation plane ---------------------------------------------------

    def journal(self) -> list[dict[str, Any]]:
        """Every request served so far, in order (see the journal entry shape)."""
        return self._state.journal()

    def journal_for(self, model: str) -> list[dict[str, Any]]:
        return self.calls(model=model)

    def calls(
        self,
        *,
        model: str | None = None,
        dialect: str | None = None,
        status: int | None = None,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Journal entries matching every given filter, in wire order."""
        return [
            entry
            for entry in self._state.journal()
            if (model is None or entry["model"] == model)
            and (dialect is None or entry["dialect"] == dialect)
            and (status is None or entry["status"] == status)
            and (source is None or entry["source"] == source)
        ]

    def describe_journal(self) -> str:
        """One line per wire call — designed for assertion failure messages."""
        lines = [
            f"#{entry['seq']} {entry['dialect']} model={entry['model']} "
            f"status={entry['status']} kind={entry['kind']} source={entry['source']} "
            f"stream={entry['stream']} reply={entry['reply_preview']!r}"
            for entry in self._state.journal()
        ]
        return "\n".join(lines) if lines else "(no provider calls journaled)"

    def reset(self) -> None:
        self._state.reset()
