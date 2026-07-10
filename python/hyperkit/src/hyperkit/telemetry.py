"""Live experiment telemetry (OTLP -> ADOT -> Prometheus/Grafana + traces).

Configuration is standard OTel environment:
``OTEL_EXPORTER_OTLP_ENDPOINT`` or signal-specific endpoints. Without an
endpoint this module is a no-op, so local/replay usage stays dependency-light in
behavior while cloud runners stream shard progress as it happens.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from hyperkit.core.snapshots import CellSnapshot

_lock = threading.Lock()
_configured = False
_metric_provider: MeterProvider | None = None
_trace_provider: TracerProvider | None = None
_meter = metrics.get_meter("hyperkit")
_tracer = trace.get_tracer("hyperkit")
_completed = _meter.create_counter("hyperkit.shards.completed")
_resolved = _meter.create_counter("hyperkit.shards.resolved")
_errors = _meter.create_counter("hyperkit.shards.errors")
_running = _meter.create_up_down_counter("hyperkit.shards.running")
_latency = _meter.create_histogram("hyperkit.shard.latency", unit="s")
_cost = _meter.create_counter("hyperkit.cost.usd", unit="USD")
_snapshots: dict[str, CellSnapshot] = {}
_cell_gauges: list[Any] = []


def configure(service_name: str = "hyperkit-runner") -> None:
    """Install private metric+trace exporters when an OTLP endpoint is configured.

    Providers stay private to hyperkit rather than replacing OTel's process-global
    providers, so a SUT in the same runner (e.g. FusionKit) can install and test
    its own provider independently.
    """

    global _configured, _meter, _tracer, _completed, _resolved, _errors, _running
    global _latency, _cost
    global _metric_provider, _trace_provider, _cell_gauges
    with _lock:
        if _configured:
            return
        _configured = True
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        metrics_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
        traces_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        if not any((endpoint, metrics_endpoint, traces_endpoint)):
            return

        resource = Resource.create({"service.name": service_name})
        metric_exporter = OTLPMetricExporter(
            endpoint=metrics_endpoint
            or (f"{endpoint.rstrip('/')}/v1/metrics" if endpoint else None)
        )
        metric_provider = MeterProvider(
            resource=resource,
            metric_readers=[
                PeriodicExportingMetricReader(
                    metric_exporter,
                    export_interval_millis=5000,
                )
            ],
        )
        trace_exporter = OTLPSpanExporter(
            endpoint=traces_endpoint or (f"{endpoint.rstrip('/')}/v1/traces" if endpoint else None)
        )
        trace_provider = TracerProvider(resource=resource)
        trace_provider.add_span_processor(BatchSpanProcessor(trace_exporter))

        _metric_provider = metric_provider
        _trace_provider = trace_provider
        _meter = metric_provider.get_meter("hyperkit")
        _tracer = trace_provider.get_tracer("hyperkit")
        _completed = _meter.create_counter("hyperkit.shards.completed")
        _resolved = _meter.create_counter("hyperkit.shards.resolved")
        _errors = _meter.create_counter("hyperkit.shards.errors")
        _running = _meter.create_up_down_counter("hyperkit.shards.running")
        _latency = _meter.create_histogram("hyperkit.shard.latency", unit="s")
        _cost = _meter.create_counter("hyperkit.cost.usd", unit="USD")
        _cell_gauges = _create_cell_gauges(_meter)


@contextmanager
def shard_span(attributes: Mapping[str, Any]) -> Iterator[None]:
    """One span around the whole shard lifecycle (SUT + scaffold + grade)."""

    with _tracer.start_as_current_span("hyperkit.shard", attributes=dict(attributes)):
        yield


def record_shard(
    attributes: Mapping[str, Any],
    *,
    resolved: bool,
    error: bool,
    latency: float,
    cost: float | None,
) -> None:
    attrs = dict(attributes)
    _completed.add(1, attrs)
    if resolved:
        _resolved.add(1, attrs)
    if error:
        _errors.add(1, attrs)
    _latency.record(latency, attrs)
    if cost is not None:
        _cost.add(cost, attrs)


def record_running(attributes: Mapping[str, Any], delta: int) -> None:
    """Increment/decrement the live in-flight shard count."""

    _running.add(delta, dict(attributes))


def set_cell_snapshots(snapshots: list[CellSnapshot]) -> None:
    """Atomically replace live hypergrid snapshots read by observable gauges."""

    with _lock:
        _snapshots.clear()
        _snapshots.update({snapshot.cell_id: snapshot for snapshot in snapshots})


def _create_cell_gauges(meter: Any) -> list[Any]:
    fields = {
        "hyperkit.cell.planned_shards": "planned_shards",
        "hyperkit.cell.completed_shards": "completed_shards",
        "hyperkit.cell.resolved_shards": "resolved_shards",
        "hyperkit.cell.errors": "errors",
        "hyperkit.cell.resolution_rate": "resolution_rate",
        "hyperkit.cell.wilson_low": "wilson_low",
        "hyperkit.cell.wilson_high": "wilson_high",
        "hyperkit.cell.cost_usd": "cost_usd",
        "hyperkit.cell.cost_per_resolve": "cost_per_resolve",
        "hyperkit.cell.latency_p50_seconds": "latency_p50_seconds",
        "hyperkit.cell.latency_p95_seconds": "latency_p95_seconds",
        "hyperkit.cell.delta_vs_best_single": "delta_vs_best_single",
        "hyperkit.cell.rank": "rank",
        "hyperkit.cell.pareto": "pareto",
        "hyperkit.shards.pending": "pending_shards",
    }
    gauges = []
    for metric_name, field_name in fields.items():
        gauges.append(
            meter.create_observable_gauge(
                metric_name,
                callbacks=[_snapshot_callback(field_name)],
            )
        )
    gauges.append(
        meter.create_observable_gauge(
            "hyperkit.cells.total",
            callbacks=[_cell_total_callback],
        )
    )
    return gauges


def _snapshot_callback(field_name: str):
    def callback(_options: CallbackOptions):
        with _lock:
            snapshots = list(_snapshots.values())
        return [
            Observation(
                int(value) if isinstance(value, bool) else value,
                snapshot.metric_attributes(),
            )
            for snapshot in snapshots
            if (value := getattr(snapshot, field_name)) is not None
        ]

    return callback


def _cell_total_callback(_options: CallbackOptions):
    with _lock:
        snapshots = list(_snapshots.values())
    grouped: dict[tuple[str, int, str], int] = {}
    for snapshot in snapshots:
        key = (snapshot.sweep_id, snapshot.generation, snapshot.benchmark)
        grouped[key] = grouped.get(key, 0) + 1
    return [
        Observation(
            count,
            {
                "hyperkit.sweep.id": sweep_id,
                "hyperkit.generation": generation,
                "hyperkit.benchmark": benchmark,
            },
        )
        for (sweep_id, generation, benchmark), count in grouped.items()
    ]

