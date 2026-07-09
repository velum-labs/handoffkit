"""Pytest fixtures for the FusionKit testkit.

Registered as a ``pytest11`` entry point, so any test in the uv workspace can
use these fixtures without imports or conftest wiring::

    def test_my_feature(provider_sim):
        provider_sim.queue("gpt-x", "hello")
        ...

Fixtures:

- ``provider_sim`` — a fresh :class:`ProviderSimulator` per test (started,
  stopped, journal isolated).
- ``sim_stack`` — a factory: ``sim_stack(members=[...])`` boots the simulator
  plus the REAL ``fusionkit serve`` engine process over it and returns
  ``(sim, engine)``; everything is torn down at test end. Engine startup costs
  ~1s, so prefer module-scoped composition (see ``tests/test_engine_process``)
  for suites with many engine tests.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Protocol

import pytest

from fusionkit_testkit.endpoints import panel_config
from fusionkit_testkit.engine import EngineProcess
from fusionkit_testkit.server import ProviderSimulator

if TYPE_CHECKING:
    from fusionkit_core.config import ModelEndpoint


class SimStackFactory(Protocol):
    def __call__(
        self,
        *,
        members: list[ModelEndpoint],
        judge: ModelEndpoint | None = None,
        synthesizer: ModelEndpoint | None = None,
    ) -> tuple[ProviderSimulator, EngineProcess]: ...


@pytest.fixture
def provider_sim() -> Iterator[ProviderSimulator]:
    with ProviderSimulator() as simulator:
        yield simulator


@pytest.fixture
def sim_stack(provider_sim: ProviderSimulator) -> Iterator[SimStackFactory]:
    engines: list[EngineProcess] = []

    def factory(
        *,
        members: list[ModelEndpoint],
        judge: ModelEndpoint | None = None,
        synthesizer: ModelEndpoint | None = None,
    ) -> tuple[ProviderSimulator, EngineProcess]:
        config = panel_config(
            provider_sim, members=members, judge=judge, synthesizer=synthesizer
        )
        engine = EngineProcess(config).start()
        engines.append(engine)
        return provider_sim, engine

    try:
        yield factory
    finally:
        for engine in engines:
            engine.stop()
