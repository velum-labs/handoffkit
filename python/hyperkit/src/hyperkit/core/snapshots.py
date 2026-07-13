"""Live per-cell hypergrid performance snapshots.

ShardResults are the durable source of truth. A snapshot is a derived,
replaceable view used by Prometheus/Grafana: progress, quality with Wilson
interval, cost efficiency, latency, delta to best single, rank, and Pareto
membership. Recomputing snapshots is deterministic and safe after controller
restart.
"""

from __future__ import annotations

from collections.abc import Sequence
from statistics import median
from typing import Any

from pydantic import BaseModel, Field

from hyperkit.core.models import Cell, ShardResult, ShardStatus
from hyperkit.stats import wilson_interval


class CellSnapshot(BaseModel):
    sweep_id: str
    generation: int
    cell_id: str
    label: str
    benchmark: str
    sut_kind: str
    topology_hash: str
    topology: str
    k: str
    panel: str
    judge: str
    commit: str
    planned_shards: int
    completed_shards: int
    pending_shards: int
    running_shards: int = 0
    resolved_shards: int
    errors: int
    resolution_rate: float
    wilson_low: float
    wilson_high: float
    cost_usd: float
    cost_per_resolve: float
    latency_p50_seconds: float
    latency_p95_seconds: float
    delta_vs_best_single: float = 0.0
    rank: int = 0
    pareto: bool = False
    params: dict[str, Any] = Field(default_factory=dict)

    def metric_attributes(self) -> dict[str, str | int]:
        """Bounded labels for Prometheus; full params stay in S3/Athena."""

        return {
            # Canonical OTel semantic attributes.
            "hyperkit.sweep.id": self.sweep_id,
            "hyperkit.generation": self.generation,
            "hyperkit.benchmark": self.benchmark,
            "hyperkit.cell.id": self.cell_id,
            "hyperkit.topology.hash": self.topology_hash,
            "hyperkit.topology": self.topology,
            "hyperkit.k": self.k,
            "hyperkit.panel": self.panel,
            "hyperkit.judge": self.judge,
            "hyperkit.commit": self.commit,
            "hyperkit.sut.kind": self.sut_kind,
            # Dashboard compatibility labels. Grafana's provisioned dashboards
            # predate the semantic names and select these concise labels.
            "run_id": self.sweep_id,
            "generation": self.generation,
            "benchmark": self.benchmark,
            "cell_id": self.cell_id,
            "topology_hash": self.topology_hash,
            "topology": self.topology,
            "k": self.k,
            "panel": self.panel,
            "judge": self.judge,
            "commit": self.commit,
            "sut_kind": self.sut_kind,
        }


def build_cell_snapshots(
    sweep_id: str,
    cells: Sequence[tuple[Cell, int]],
    results: Sequence[ShardResult],
) -> list[CellSnapshot]:
    """Recompute all cell snapshots from materialized cells + durable results."""

    by_cell: dict[str, list[ShardResult]] = {}
    for result in results:
        by_cell.setdefault(result.cell_id, []).append(result)

    snapshots = [
        _snapshot(sweep_id, cell, generation, by_cell.get(cell.cell_id, []))
        for cell, generation in cells
    ]

    best_solo: dict[str, float] = {}
    for snapshot in snapshots:
        if snapshot.sut_kind == "solo-model":
            best_solo[snapshot.benchmark] = max(
                best_solo.get(snapshot.benchmark, 0.0),
                snapshot.resolution_rate,
            )

    for snapshot in snapshots:
        snapshot.delta_vs_best_single = (
            snapshot.resolution_rate - best_solo.get(snapshot.benchmark, 0.0)
        )

    by_benchmark: dict[str, list[CellSnapshot]] = {}
    for snapshot in snapshots:
        by_benchmark.setdefault(snapshot.benchmark, []).append(snapshot)
    for group in by_benchmark.values():
        ordered = sorted(
            group,
            key=lambda item: (-item.resolution_rate, item.cost_usd, item.cell_id),
        )
        for rank, snapshot in enumerate(ordered, start=1):
            snapshot.rank = rank
            snapshot.pareto = _is_pareto(snapshot, group)
    return snapshots


def _snapshot(
    sweep_id: str,
    cell: Cell,
    generation: int,
    results: Sequence[ShardResult],
) -> CellSnapshot:
    completed = [
        result
        for result in results
        if result.status in {ShardStatus.RESOLVED, ShardStatus.UNRESOLVED, ShardStatus.ERROR}
    ]
    graded = [
        result
        for result in completed
        if result.status in {ShardStatus.RESOLVED, ShardStatus.UNRESOLVED}
    ]
    resolved = sum(result.resolved for result in graded)
    errors = sum(result.status == ShardStatus.ERROR for result in completed)
    ci = wilson_interval(resolved, len(graded))
    cost = sum(result.cost_usd or 0.0 for result in completed)
    latencies = sorted(
        result.latency_s for result in completed if result.latency_s is not None
    )
    params = {**cell.sut.params, **cell.params}
    return CellSnapshot(
        sweep_id=sweep_id,
        generation=generation,
        cell_id=cell.cell_id,
        label=cell.label or cell.cell_id,
        benchmark=cell.benchmark,
        sut_kind=cell.sut.kind,
        topology_hash=cell.sut.hash,
        topology=_axis(params, "topology", "workflow", default=cell.sut.kind),
        k=_axis(params, "k"),
        panel=_panel(params.get("panel")),
        judge=_axis(params, "judge"),
        commit=_axis(params, "commit"),
        planned_shards=len(cell.instances),
        completed_shards=len(completed),
        pending_shards=max(0, len(cell.instances) - len(completed)),
        resolved_shards=resolved,
        errors=errors,
        resolution_rate=ci.estimate,
        wilson_low=ci.low,
        wilson_high=ci.high,
        cost_usd=cost,
        cost_per_resolve=cost / resolved if resolved else 0.0,
        latency_p50_seconds=median(latencies) if latencies else 0.0,
        latency_p95_seconds=_percentile(latencies, 0.95),
        params=params,
    )


def _axis(params: dict[str, Any], *names: str, default: str = "") -> str:
    for name in names:
        value = params.get(name)
        if value is not None:
            return str(value)
    return default


def _panel(value: Any) -> str:
    if isinstance(value, list):
        return "+".join(str(item) for item in value)
    return "" if value is None else str(value)


def _percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        return 0.0
    index = min(len(values) - 1, max(0, int(round((len(values) - 1) * quantile))))
    return float(values[index])


def _is_pareto(candidate: CellSnapshot, group: Sequence[CellSnapshot]) -> bool:
    """Maximize resolution rate while minimizing cost; ties are Pareto-equal."""

    return not any(
        other.cell_id != candidate.cell_id
        and other.resolution_rate >= candidate.resolution_rate
        and other.cost_usd <= candidate.cost_usd
        and (
            other.resolution_rate > candidate.resolution_rate
            or other.cost_usd < candidate.cost_usd
        )
        for other in group
    )

