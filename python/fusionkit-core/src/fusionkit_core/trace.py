"""OpenTelemetry-based tracing for the fusion engine.

The engine is the OTel SDK (ids, W3C ``traceparent``/``baggage`` propagation,
batching, OTLP export); this module owns the thin domain layer: typed span
helpers over the fusion semantic conventions (``spec/fusion-trace``), header
extraction for incoming requests, and the event primitive for live
point-in-time signals. Unit-of-work spans ride the OTLP traces signal; fusion
events are OTel events (log records with an ``event_name``) on the logs
signal, exported immediately so dashboards stay live while a span is open.

Configuration is the standard OTLP env: ``OTEL_EXPORTER_OTLP_ENDPOINT`` as
the base (set by ``fusionkit ... --observe`` to the scope collector, or by
the user to any OTLP backend such as PostHog), with the signal-specific
``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` / ``OTEL_EXPORTER_OTLP_LOGS_ENDPOINT``
winning when set. Without an endpoint every helper is a no-op, so normal
runs are unaffected.
"""

from __future__ import annotations

import atexit
import json
import os
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from google.protobuf.json_format import MessageToDict
from opentelemetry import _logs as otel_logs
from opentelemetry import baggage as otel_baggage
from opentelemetry import propagate
from opentelemetry import trace as otel_trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.common._log_encoder import encode_logs
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk._logs import LoggerProvider, LogRecordProcessor
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    LogRecordExporter,
    LogRecordExportResult,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import Span, StatusCode

from fusionkit_core._generated.trace_conventions import ATTR, FUSION_SCOPES

__all__ = [
    "ATTR",
    "FUSION_SCOPES",
    "Span",
    "TraceContext",
    "candidate_baggage_of",
    "context_from_headers",
    "context_of_span",
    "emit_event",
    "end_fusion_span",
    "fusion_span",
    "is_tracing_configured",
    "json_attr",
    "start_fusion_span",
    "setup_fusion_tracing",
    "shutdown_fusion_tracing",
]

# An opaque handle threaded through the engine (kernel -> judge); ``None``
# means "no ambient trace" and every helper no-ops gracefully.
TraceContext = Context

_lock = threading.Lock()
_provider: TracerProvider | None = None
_logger_provider: LoggerProvider | None = None


def is_tracing_configured() -> bool:
    """True when signals have somewhere to go (standard OTLP env is set)."""
    endpoint = (
        os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    )
    return bool(endpoint)


def setup_fusion_tracing(
    service_name: str,
    *,
    extra_processors: list[SpanProcessor] | None = None,
    extra_log_processors: list[LogRecordProcessor] | None = None,
) -> None:
    """Install the tracer and logger providers (idempotent; first call wins).

    Without an OTLP endpoint and without ``extra_processors`` /
    ``extra_log_processors`` (used by tests to capture spans/events in
    memory) this is a no-op: the global tracer and logger stay no-ops and
    every helper below emits nothing.
    """
    global _provider, _logger_provider
    with _lock:
        if _provider is not None:
            return
        processors: list[SpanProcessor] = list(extra_processors or [])
        log_processors: list[LogRecordProcessor] = list(extra_log_processors or [])
        if is_tracing_configured():
            # Live dashboards want signals quickly; 500ms batches keep exports
            # frequent without per-signal requests.
            processors.append(
                BatchSpanProcessor(_JsonOtlpSpanExporter(), schedule_delay_millis=500)
            )
            log_processors.append(
                BatchLogRecordProcessor(_JsonOtlpLogExporter(), schedule_delay_millis=500)
            )
        if not processors and not log_processors:
            return
        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource)
        for processor in processors:
            provider.add_span_processor(processor)
        otel_trace.set_tracer_provider(provider)
        logger_provider = LoggerProvider(resource=resource)
        for log_processor in log_processors:
            logger_provider.add_log_record_processor(log_processor)
        otel_logs.set_logger_provider(logger_provider)
        _provider = provider
        _logger_provider = logger_provider
        atexit.register(shutdown_fusion_tracing)


def shutdown_fusion_tracing() -> None:
    """Flush and shut the providers down (bounded by the exporter timeouts)."""
    global _provider, _logger_provider
    provider = _provider
    logger_provider = _logger_provider
    _provider = None
    _logger_provider = None
    if provider is not None:
        provider.shutdown()
    if logger_provider is not None:
        logger_provider.shutdown()


class _JsonOtlpSpanExporter(SpanExporter):
    """OTLP/HTTP with a JSON body (the protobuf JSON mapping).

    The stock ``opentelemetry-exporter-otlp-proto-http`` exporter only speaks
    binary protobuf, and the official ``opentelemetry-exporter-otlp-json-http``
    package is not yet published to PyPI (its ``opentelemetry-proto-json``
    dependency never shipped). Until it lands, this exporter reuses the
    official protobuf encoder and serializes the message with protobuf's
    standard JSON mapping — receivers (the scope collector, and OTLP servers
    that follow the spec's "accept both encodings" guidance) decode it
    directly. Queueing/batching stay with ``BatchSpanProcessor``.
    """

    def __init__(self) -> None:
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        if not endpoint:
            base = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").rstrip("/")
            endpoint = f"{base}/v1/traces" if base else ""
        self._endpoint = endpoint
        self._headers = _parse_otlp_headers(
            os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS")
            or os.environ.get("OTEL_EXPORTER_OTLP_HEADERS")
        )

    def export(self, spans: Any) -> SpanExportResult:
        if not self._endpoint:
            return SpanExportResult.SUCCESS
        body = json.dumps(MessageToDict(encode_spans(spans))).encode("utf-8")
        request = urllib_request.Request(
            self._endpoint,
            data=body,
            headers={"content-type": "application/json", **self._headers},
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=5.0):
                return SpanExportResult.SUCCESS
        except (urllib_error.URLError, OSError, ValueError):
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        return None


class _JsonOtlpLogExporter(LogRecordExporter):
    """OTLP/HTTP logs with a JSON body (the protobuf JSON mapping).

    The logs twin of :class:`_JsonOtlpSpanExporter`: the official protobuf log
    encoder builds the ``ExportLogsServiceRequest`` and protobuf's standard
    JSON mapping serializes it. Queueing/batching stay with
    ``BatchLogRecordProcessor``.
    """

    def __init__(self) -> None:
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
        if not endpoint:
            base = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").rstrip("/")
            endpoint = f"{base}/v1/logs" if base else ""
        self._endpoint = endpoint
        self._headers = _parse_otlp_headers(
            os.environ.get("OTEL_EXPORTER_OTLP_LOGS_HEADERS")
            or os.environ.get("OTEL_EXPORTER_OTLP_HEADERS")
        )

    def export(self, batch: Sequence[Any]) -> LogRecordExportResult:
        if not self._endpoint:
            return LogRecordExportResult.SUCCESS
        body = json.dumps(MessageToDict(encode_logs(batch))).encode("utf-8")
        request = urllib_request.Request(
            self._endpoint,
            data=body,
            headers={"content-type": "application/json", **self._headers},
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=5.0):
                return LogRecordExportResult.SUCCESS
        except (urllib_error.URLError, OSError, ValueError):
            return LogRecordExportResult.FAILURE

    def shutdown(self) -> None:
        return None


def _parse_otlp_headers(raw: str | None) -> dict[str, str]:
    """Parse the standard `k1=v1,k2=v2` OTLP headers env format."""
    headers: dict[str, str] = {}
    for pair in (raw or "").split(","):
        key, sep, value = pair.partition("=")
        if sep and key.strip():
            headers[key.strip()] = value.strip()
    return headers


def _tracer(scope: str) -> otel_trace.Tracer:
    return otel_trace.get_tracer(FUSION_SCOPES.get(scope, scope))


def _logger(scope: str) -> otel_logs.Logger:
    return otel_logs.get_logger(FUSION_SCOPES.get(scope, scope))


def context_from_headers(headers: Mapping[str, str] | None) -> TraceContext | None:
    """The W3C trace context carried by incoming request headers, if any.

    Returns ``None`` when there is no usable ``traceparent`` so downstream
    signals are dropped rather than starting orphan traces.
    """
    if not headers:
        return None
    carrier = {key.lower(): value for key, value in headers.items()}
    if not carrier.get("traceparent"):
        return None
    return propagate.extract(carrier)


def candidate_baggage_of(ctx: TraceContext | None) -> dict[str, str]:
    """Fusion correlation entries (candidate/trajectory ids, turn) from baggage."""
    if ctx is None:
        return {}
    out: dict[str, str] = {}
    for key in ("fusion.candidate.id", "fusion.trajectory.id", "fusion.turn"):
        value = otel_baggage.get_baggage(key, ctx)
        if isinstance(value, str) and value:
            out[key] = value
    return out


def json_attr(value: Any) -> str | None:
    """JSON-stringify a structured value into an attribute (None passes through)."""
    if value is None:
        return None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return None


def _compact(attributes: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in attributes.items() if value is not None}


def emit_event(
    scope: str,
    name: str,
    ctx: TraceContext | None,
    attributes: Mapping[str, Any],
) -> None:
    """Emit a fusion event (the live-signal primitive).

    An OTel log record carrying ``event_name``, the fusion attributes, and
    the trace/span ids from ``ctx``. A no-op when there is no ambient trace
    context — a signal with no trace identity has no consumer.
    """
    if ctx is None:
        return
    _logger(scope).emit(
        event_name=name,
        context=ctx,
        severity_number=SeverityNumber.INFO,
        attributes=_compact(attributes),
    )


@contextmanager
def fusion_span(
    scope: str,
    name: str,
    ctx: TraceContext | None,
    attributes: Mapping[str, Any] | None = None,
) -> Iterator[Span]:
    """A real unit-of-work span parented onto ``ctx``.

    Exceptions mark the span failed (``fusion.status`` + error status) and
    re-raise; normal exit marks it succeeded unless the body already set a
    terminal status attribute.
    """
    span = _tracer(scope).start_span(
        name, context=ctx, attributes=_compact(attributes or {})
    )
    try:
        yield span
    except Exception as exc:
        span.set_attribute(ATTR.FUSION_STATUS, "failed")
        span.set_attribute(ATTR.FUSION_ERROR, str(exc)[:500])
        span.set_status(StatusCode.ERROR, str(exc)[:200])
        span.end()
        raise
    else:
        span.set_status(StatusCode.OK)
        span.end()


def context_of_span(span: Span, ctx: TraceContext | None = None) -> TraceContext:
    """A context in which ``span`` is current (for correlating events/children)."""
    return otel_trace.set_span_in_context(span, ctx)


def start_fusion_span(
    scope: str,
    name: str,
    ctx: TraceContext | None,
    attributes: Mapping[str, Any] | None = None,
) -> Span | None:
    """Manual-lifecycle variant of :func:`fusion_span` for generators.

    Returns ``None`` when there is no ambient trace context; end with
    :func:`end_fusion_span`.
    """
    if ctx is None:
        return None
    return _tracer(scope).start_span(name, context=ctx, attributes=_compact(attributes or {}))


def end_fusion_span(span: Span | None, *, error: str | None = None) -> None:
    """End a span from :func:`start_fusion_span`, marking failure when given."""
    if span is None:
        return
    if error is not None:
        span.set_attribute(ATTR.FUSION_STATUS, "failed")
        span.set_attribute(ATTR.FUSION_ERROR, error[:500])
        span.set_status(StatusCode.ERROR, error[:200])
    else:
        span.set_status(StatusCode.OK)
    span.end()
