"""Fire-and-forget observability emitter for the fusion-trace-event.v1 contract.

This module is intentionally dependency-free (stdlib only) so it can be imported by
lightweight scripts (the panel model servers) as well as the core engine. Emission is a
no-op unless ``FUSION_TRACE_URL`` or ``FUSION_TRACE_DIR`` is set, so normal runs are
unaffected and never blocked by the collector being slow or down.

Environment variables:
    FUSION_TRACE_URL  HTTP endpoint that accepts ingested events (e.g. the scopekit
                      collector at http://127.0.0.1:4317/api/ingest).
    FUSION_TRACE_DIR  Directory for a durable JSONL fallback (one file per trace id).
    FUSION_TRACE_ID   Ambient trace id to attach when a caller does not supply one.
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import threading
import time
import uuid
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

FUSION_TRACE_EVENT_SCHEMA = "fusion-trace-event.v1"
FUSION_TRACE_EVENT_VERSION = "1.0.0"

TRACE_ID_HEADER = "x-fusion-trace-id"
TRACE_SPAN_HEADER = "x-fusion-span-id"
TRACE_PARENT_SPAN_HEADER = "x-fusion-parent-span-id"
TRACE_CANDIDATE_HEADER = "x-fusion-candidate-id"

_QUEUE_MAX = 4096
_POST_TIMEOUT_S = 2.0


def new_trace_id() -> str:
    return f"trace_{uuid.uuid4().hex}"


def new_span_id() -> str:
    return f"span_{uuid.uuid4().hex[:12]}"


def ambient_trace_id() -> str | None:
    value = os.environ.get("FUSION_TRACE_ID")
    return value if value else None


class TraceEmitter:
    """A background-threaded emitter. One per process is plenty."""

    def __init__(
        self,
        *,
        url: str | None = None,
        directory: str | None = None,
    ) -> None:
        self._url = url if url is not None else os.environ.get("FUSION_TRACE_URL") or None
        self._dir = (
            directory if directory is not None else os.environ.get("FUSION_TRACE_DIR") or None
        )
        self._enabled = bool(self._url or self._dir)
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=_QUEUE_MAX)
        self._worker: threading.Thread | None = None
        if self._enabled and self._dir:
            try:
                os.makedirs(self._dir, exist_ok=True)
            except OSError:
                self._dir = None
                self._enabled = bool(self._url)
        if self._enabled:
            self._worker = threading.Thread(target=self._run, name="fusion-trace", daemon=True)
            self._worker.start()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _next_seq(self) -> int:
        with self._seq_lock:
            value = self._seq
            self._seq += 1
            return value

    def emit(
        self,
        *,
        component: str,
        event_type: str,
        trace_id: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        candidate_id: str | None = None,
        model_id: str | None = None,
        session_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        if not self._enabled:
            return
        resolved_trace = trace_id or ambient_trace_id()
        if not resolved_trace:
            return
        event: dict[str, Any] = {
            "schema": FUSION_TRACE_EVENT_SCHEMA,
            "schema_version": FUSION_TRACE_EVENT_VERSION,
            "trace_id": resolved_trace,
            "span_id": span_id or new_span_id(),
            "seq": self._next_seq(),
            "ts": time.time() * 1000.0,
            "component": component,
            "event_type": event_type,
        }
        if parent_span_id:
            event["parent_span_id"] = parent_span_id
        if session_id:
            event["session_id"] = session_id
        if candidate_id:
            event["candidate_id"] = candidate_id
        if model_id:
            event["model_id"] = model_id
        if payload is not None:
            event["payload"] = payload
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(event)

    def _run(self) -> None:
        while True:
            event = self._queue.get()
            if event is None:
                return
            self._write_jsonl(event)
            self._post(event)

    def _write_jsonl(self, event: dict[str, Any]) -> None:
        if not self._dir:
            return
        path = os.path.join(self._dir, f"{event['trace_id']}.jsonl")
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(event) + "\n")
        except OSError:
            pass

    def _post(self, event: dict[str, Any]) -> None:
        if not self._url:
            return
        body = json.dumps({"events": [event]}).encode("utf-8")
        request = urllib_request.Request(
            self._url,
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=_POST_TIMEOUT_S):
                pass
        except (urllib_error.URLError, OSError, ValueError):
            pass

    def close(self, timeout: float = 2.0) -> None:
        if not self._enabled or self._worker is None:
            return
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            return
        self._worker.join(timeout=timeout)


_default_lock = threading.Lock()
_default_emitter: TraceEmitter | None = None


def get_emitter() -> TraceEmitter:
    """Return the process-wide emitter, constructing it on first use."""
    global _default_emitter
    if _default_emitter is None:
        with _default_lock:
            if _default_emitter is None:
                _default_emitter = TraceEmitter()
    return _default_emitter


def emit(
    *,
    component: str,
    event_type: str,
    trace_id: str | None = None,
    span_id: str | None = None,
    parent_span_id: str | None = None,
    candidate_id: str | None = None,
    model_id: str | None = None,
    session_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Convenience wrapper around the process-wide emitter."""
    get_emitter().emit(
        component=component,
        event_type=event_type,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        candidate_id=candidate_id,
        model_id=model_id,
        session_id=session_id,
        payload=payload,
    )
