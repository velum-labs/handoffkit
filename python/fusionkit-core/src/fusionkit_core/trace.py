"""OpenTelemetry-based tracing for the fusion engine.

The engine is the OTel SDK (ids, W3C ``traceparent``/``baggage`` propagation,
batching, OTLP export); this module owns the thin domain layer: typed span
helpers over the fusion semantic conventions (``spec/fusion-trace``), header
extraction for incoming requests, and the marker primitive for live
point-in-time signals.

Configuration is the standard ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` (set by
``fusionkit ... --observe`` to the scope collector, or by the user to any OTLP
backend such as PostHog). Without an endpoint every helper is a no-op, so
normal runs are unaffected.
"""

from __future__ import annotations

import atexit
import json
import os
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from opentelemetry import baggage as otel_baggage
from opentelemetry import propagate
from opentelemetry import trace as otel_trace
from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
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
    "emit_marker",
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


def is_tracing_configured() -> bool:
    """True when spans have somewhere to go (standard OTLP env is set)."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT"
    )
    return bool(endpoint)


def setup_fusion_tracing(
    service_name: str,
    *,
    extra_processors: list[SpanProcessor] | None = None,
) -> None:
    """Install the tracer provider (idempotent; first call wins).

    Without an OTLP endpoint and without ``extra_processors`` (used by tests to
    capture spans in memory) this is a no-op: the global tracer stays a no-op
    and every helper below emits nothing.
    """
    global _provider
    with _lock:
        if _provider is not None:
            return
        processors: list[SpanProcessor] = list(extra_processors or [])
        if is_tracing_configured():
            # Imported lazily so environments without the exporter extra still
            # import fusionkit_core.trace (helpers just stay no-ops).
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            # Live dashboards want markers quickly; 500ms batches keep exports
            # frequent without per-span requests.
            processors.append(BatchSpanProcessor(OTLPSpanExporter(), schedule_delay_millis=500))
        if not processors:
            return
        provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
        for processor in processors:
            provider.add_span_processor(processor)
        otel_trace.set_tracer_provider(provider)
        _provider = provider
        atexit.register(shutdown_fusion_tracing)


def shutdown_fusion_tracing() -> None:
    """Flush and shut the provider down (bounded by the exporter timeout)."""
    global _provider
    provider = _provider
    _provider = None
    if provider is not None:
        provider.shutdown()


def _tracer(scope: str) -> otel_trace.Tracer:
    return otel_trace.get_tracer(FUSION_SCOPES.get(scope, scope))


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


def emit_marker(
    scope: str,
    name: str,
    ctx: TraceContext | None,
    attributes: Mapping[str, Any],
) -> None:
    """Emit an instant marker span (the live-signal primitive).

    A no-op when there is no ambient trace context — a signal with no trace
    identity has no consumer.
    """
    if ctx is None:
        return
    span = _tracer(scope).start_span(name, context=ctx, attributes=_compact(attributes))
    span.end()


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
    """A context in which ``span`` is current (for parenting markers/children)."""
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
