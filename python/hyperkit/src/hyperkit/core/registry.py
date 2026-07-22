"""Plugin registry for adapters, SUTs, compute backends, and experiments.

Plugins register either in-process (``register_*``) or via entry-points in the
``hyperkit.benchmarks`` / ``hyperkit.suts`` / ``hyperkit.backends`` groups, so a
package like fusionkit can contribute a SUT without the core importing it. Also
holds the generic model/endpoint registry (absorbed from fusionkit-lab): a plain
id -> endpoint-metadata map with no fusion semantics.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from importlib.metadata import entry_points
from pathlib import Path
from typing import Any, TypeVar

import yaml
from pydantic import BaseModel, Field

from hyperkit.core.contracts import BenchmarkAdapter, ComputeBackend, SystemUnderTest

T = TypeVar("T")

_benchmarks: dict[str, BenchmarkAdapter] = {}
_suts: dict[str, SystemUnderTest] = {}
_backends: dict[str, ComputeBackend] = {}

_EP_GROUPS = {
    "hyperkit.benchmarks": _benchmarks,
    "hyperkit.suts": _suts,
    "hyperkit.backends": _backends,
}
_loaded_entry_points = False


def register_benchmark(adapter: BenchmarkAdapter) -> BenchmarkAdapter:
    _benchmarks[adapter.name] = adapter
    return adapter


def register_sut(sut: SystemUnderTest) -> SystemUnderTest:
    _suts[sut.kind] = sut
    return sut


def register_backend(backend: ComputeBackend) -> ComputeBackend:
    _backends[backend.name] = backend
    return backend


def _load_entry_points() -> None:
    global _loaded_entry_points
    if _loaded_entry_points:
        return
    _loaded_entry_points = True
    for group, target in _EP_GROUPS.items():
        try:
            eps = entry_points(group=group)
        except TypeError:  # pragma: no cover - very old importlib.metadata
            eps = entry_points().get(group, [])  # type: ignore[attr-defined]
        for ep in eps:
            factory: Callable[[], Any] = ep.load()
            obj = factory()
            key = getattr(obj, "name", None) or getattr(obj, "kind", ep.name)
            target[key] = obj


def get_benchmark(name: str) -> BenchmarkAdapter:
    _load_entry_points()
    if name not in _benchmarks:
        raise KeyError(f"no benchmark adapter registered for {name!r} (have {list(_benchmarks)})")
    return _benchmarks[name]


def get_sut(kind: str) -> SystemUnderTest:
    _load_entry_points()
    if kind not in _suts:
        raise KeyError(f"no SUT registered for {kind!r} (have {list(_suts)})")
    return _suts[kind]


def get_backend(name: str) -> ComputeBackend:
    _load_entry_points()
    if name not in _backends:
        raise KeyError(f"no compute backend registered for {name!r} (have {list(_backends)})")
    return _backends[name]


def known_benchmarks() -> list[str]:
    _load_entry_points()
    return sorted(_benchmarks)


# --- Generic model/endpoint registry (SUT-agnostic; absorbs fusionkit-lab) ----


class EndpointRecord(BaseModel):
    """One model endpoint's identity + routing/pricing metadata.

    No fusion semantics -- a panel is just a list of these ids, assembled by a
    SUT plugin, not by the core.
    """

    id: str
    provider: str
    model: str
    base_url: str = ""
    api_key_env: str | None = None
    input_cost_per_1m: float | None = None
    output_cost_per_1m: float | None = None
    max_completion_tokens: int | None = None
    escalated_completion_tokens: int | None = None
    lineage: list[str] = Field(default_factory=list)
    generation: str | None = None
    tags: list[str] = Field(default_factory=list)


class ModelRegistry(BaseModel):
    cycle_id: str | None = None
    endpoints: dict[str, EndpointRecord] = Field(default_factory=dict)

    def add(self, record: EndpointRecord) -> None:
        self.endpoints[record.id] = record

    def get(self, endpoint_id: str) -> EndpointRecord:
        return self.endpoints[endpoint_id]

    def with_tag(self, tag: str) -> list[EndpointRecord]:
        return [e for e in self.endpoints.values() if tag in e.tags]


def load_model_registry(path: Path) -> ModelRegistry:
    """Load either the normalized endpoint-map schema or the former lab schema."""

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"registry file must contain a mapping: {path}")
    if "endpoints" in data:
        return ModelRegistry.model_validate(data)

    # Clean-break import of the old fusionkit-lab schema. The old package is
    # deleted; this loader is the only canonical reader from now on.
    records: dict[str, EndpointRecord] = {}
    for raw in data.get("models", []):
        endpoint_id = raw["endpoint_id"]
        records[endpoint_id] = EndpointRecord(
            id=endpoint_id,
            provider=raw["provider"],
            model=raw["model"],
            base_url=raw.get("base_url", ""),
            api_key_env=raw.get("api_key_env"),
            input_cost_per_1m=raw.get("input_price_per_m"),
            output_cost_per_1m=raw.get("output_price_per_m"),
            max_completion_tokens=raw.get("max_completion_tokens"),
            escalated_completion_tokens=raw.get("escalated_completion_tokens"),
            lineage=raw.get("lineage", []),
            generation=raw.get("generation"),
        )
    return ModelRegistry(cycle_id=data.get("cycle_id"), endpoints=records)


def endpoint_identity_hash(endpoint: EndpointRecord) -> str:
    """Hash behavior-pinning fields (not accounting metadata)."""

    payload = {
        "base_url": endpoint.base_url,
        "escalated_completion_tokens": endpoint.escalated_completion_tokens,
        "max_completion_tokens": endpoint.max_completion_tokens,
        "model": endpoint.model,
        "provider": endpoint.provider,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]


def lineage_conflicts(a: EndpointRecord, b: EndpointRecord) -> bool:
    return bool(set(a.lineage).intersection(b.lineage))
