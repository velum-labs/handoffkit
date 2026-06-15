from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel


class ParetoPoint(BaseModel):
    id: str
    quality: float
    latency_s: float
    peak_memory_gb: float | None = None
    energy_j: float | None = None
    metadata: dict[str, object] = {}


def find_pareto_front(points: Iterable[ParetoPoint]) -> list[ParetoPoint]:
    point_list = list(points)
    return [
        point
        for point in point_list
        if not any(_dominates(other, point) for other in point_list if other.id != point.id)
    ]


def load_points(path: str | Path) -> list[ParetoPoint]:
    with Path(path).open(encoding="utf-8") as handle:
        return [ParetoPoint.model_validate_json(line) for line in handle if line.strip()]


def write_pareto_report(path: str | Path, points: Iterable[ParetoPoint]) -> None:
    front = find_pareto_front(points)
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps([point.model_dump(mode="json") for point in front], indent=2),
        encoding="utf-8",
    )


def _dominates(left: ParetoPoint, right: ParetoPoint) -> bool:
    comparisons = [
        left.quality >= right.quality,
        left.latency_s <= right.latency_s,
    ]
    strict = [
        left.quality > right.quality,
        left.latency_s < right.latency_s,
    ]
    if left.peak_memory_gb is not None and right.peak_memory_gb is not None:
        comparisons.append(left.peak_memory_gb <= right.peak_memory_gb)
        strict.append(left.peak_memory_gb < right.peak_memory_gb)
    if left.energy_j is not None and right.energy_j is not None:
        comparisons.append(left.energy_j <= right.energy_j)
        strict.append(left.energy_j < right.energy_j)
    return all(comparisons) and any(strict)
