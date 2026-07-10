"""Experiment base + the stock declarative (YAML) implementation.

An Experiment is code implementing the contract; CartesianExperiment is the
one built-in that reads a YAML matrix and takes the cartesian product of its
axes. Both produce the same materialized ``Cell`` objects -- one contract, not
two surfaces.
"""

from __future__ import annotations

import importlib.util
import inspect
import itertools
import sys
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any, TypeVar

import yaml

from hyperkit.core.contracts import ExperimentContext
from hyperkit.core.ids import hash_ids
from hyperkit.core.models import Cell, ResourceProfile, ShardResult, TopologySpec

E = TypeVar("E", bound=type["Experiment"])


class Experiment:
    """Base class: subclasses override ``cells`` (and optionally ``on_results``)."""

    id: str = "experiment"

    def cells(self, ctx: ExperimentContext) -> Iterable[Cell]:  # pragma: no cover - abstract
        raise NotImplementedError

    def on_results(
        self, results: Sequence[ShardResult], ctx: ExperimentContext
    ) -> Iterable[Cell]:
        return []


def experiment(id: str) -> Callable[[E], E]:
    """Class decorator assigning the durable experiment id.

    Example::

        @experiment(id="k1-grid-001")
        class Grid(Experiment):
            def cells(self, ctx): ...
    """

    if not id:
        raise ValueError("experiment id must not be empty")

    def decorate(cls: E) -> E:
        cls.id = id
        return cls

    return decorate


def load_experiment(ref: str) -> Experiment:
    """Load arbitrary experiment code (``path.py[:symbol]``) or YAML.

    Materialization is still the deterministic boundary: callers evaluate this
    once and freeze the yielded Cells into the lock. Runners never import the
    experiment module.
    """

    file_ref, sep, symbol = ref.partition(":")
    path = Path(file_ref).resolve()
    if path.suffix in {".yaml", ".yml"}:
        return CartesianExperiment.from_yaml(path)
    if path.suffix != ".py":
        raise ValueError(f"experiment must be a .py/.yaml file: {path}")

    module_name = f"_hyperkit_experiment_{hash_ids([str(path)])}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load experiment module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    if sep:
        candidate = getattr(module, symbol)
    elif hasattr(module, "EXPERIMENT"):
        candidate = module.EXPERIMENT
    else:
        classes = [
            obj
            for _, obj in inspect.getmembers(module, inspect.isclass)
            if issubclass(obj, Experiment)
            and obj is not Experiment
            and obj.__module__ == module_name
        ]
        if len(classes) != 1:
            raise ValueError(
                f"{path} must expose EXPERIMENT or exactly one Experiment subclass; "
                f"found {[cls.__name__ for cls in classes]}"
            )
        candidate = classes[0]
    resolved = candidate() if inspect.isclass(candidate) else candidate
    if not isinstance(resolved, Experiment):
        raise TypeError(f"{ref} did not resolve to a hyperkit Experiment")
    return resolved


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


class CartesianExperiment(Experiment):
    """Cartesian product over declared axes -- the simple, common case.

    Matrix shape (see docs): ``benchmarks``, ``instances`` (per-benchmark ref),
    ``sut`` (kind, default ``fusionkit-serve``), and ``axes`` (a dict of
    name -> list). Each axis combination becomes a cell's ``params``; SUT-shaping
    of those params is left to the SUT plugin, keeping the core SUT-agnostic.
    """

    def __init__(self, spec: dict[str, Any], *, experiment_id: str = "cartesian"):
        self.id = experiment_id
        self.spec = spec

    @classmethod
    def from_yaml(cls, path: Path) -> CartesianExperiment:
        data = yaml.safe_load(Path(path).read_text())
        return cls(data, experiment_id=data.get("id", Path(path).stem))

    def cells(self, ctx: ExperimentContext) -> Iterable[Cell]:
        benchmarks = _as_list(self.spec.get("benchmarks", []))
        instances_spec: dict[str, str] = self.spec.get("instances", {})
        sut_kind = self.spec.get("sut", "fusionkit-serve")
        default_mem = float(self.spec.get("resource", {}).get("memory_gb", 6.0))
        axes: dict[str, list[Any]] = {k: _as_list(v) for k, v in self.spec.get("axes", {}).items()}
        axis_names = list(axes)

        combos = list(itertools.product(*(axes[name] for name in axis_names))) or [()]
        for benchmark in benchmarks:
            ref = instances_spec.get(benchmark, "")
            instance_ids = ctx.manifest(benchmark, ref)
            # Pin the materialized instance set; custom Experiment code may set
            # a different hash when its benchmark adapter carries richer data.
            dataset_hash = hash_ids(instance_ids)
            for combo in combos:
                params = dict(zip(axis_names, combo, strict=True))
                sut = TopologySpec(kind=sut_kind, params=params)
                label = ",".join(f"{k}={v}" for k, v in params.items()) or sut_kind
                yield Cell(
                    sut=sut,
                    benchmark=benchmark,
                    instances=instance_ids,
                    manifest_ref=ref,
                    dataset_hash=dataset_hash,
                    params=params,
                    resource=ResourceProfile(memory_gb=default_mem),
                    label=f"{benchmark}[{label}]",
                )
