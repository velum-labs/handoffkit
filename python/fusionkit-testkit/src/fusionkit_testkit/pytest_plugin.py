"""Pytest fixtures for the FusionKit testkit.

Registered as a ``pytest11`` entry point, so any test in the uv workspace can
use these fixtures without imports or conftest wiring::

    def test_my_feature(routekit_sim):
        routekit_sim.queue("endpoint-x", "hello")
        ...

Fixtures:

- ``routekit_sim`` — a fresh :class:`RouteKitSimulator` per test (started,
  stopped, journal isolated).
- ``sim_stack`` — a factory: ``sim_stack(members=[...])`` boots the simulator
  plus the REAL ``fusionkit serve`` engine process over it and returns
  ``(sim, engine)``; everything is torn down at test end. Engine startup costs
  ~1s, so prefer module-scoped composition (see ``tests/test_engine_process``)
  for suites with many engine tests.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Protocol

import pytest

from fusionkit_testkit.endpoints import SimModel, panel_config
from fusionkit_testkit.engine import EngineProcess
from fusionkit_testkit.server import RouteKitSimulator


class SimStackFactory(Protocol):
    def __call__(
        self,
        *,
        members: list[SimModel],
        judge: SimModel | None = None,
        synthesizer: SimModel | None = None,
    ) -> tuple[RouteKitSimulator, EngineProcess]: ...


@pytest.fixture
def routekit_sim() -> Iterator[RouteKitSimulator]:
    with RouteKitSimulator() as simulator:
        yield simulator


@pytest.fixture
def sim_stack(routekit_sim: RouteKitSimulator) -> Iterator[SimStackFactory]:
    engines: list[EngineProcess] = []

    def factory(
        *,
        members: list[SimModel],
        judge: SimModel | None = None,
        synthesizer: SimModel | None = None,
    ) -> tuple[RouteKitSimulator, EngineProcess]:
        config = panel_config(
            routekit_sim, members=members, judge=judge, synthesizer=synthesizer
        )
        engine = EngineProcess(config).start()
        engines.append(engine)
        return routekit_sim, engine

    try:
        yield factory
    finally:
        for engine in engines:
            engine.stop()
