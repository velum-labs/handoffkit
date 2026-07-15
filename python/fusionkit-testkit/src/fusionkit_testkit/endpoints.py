"""Config builders that point the neutral RouteKit client at the simulator."""

from __future__ import annotations

from dataclasses import dataclass

from fusionkit_core.config import FusionConfig, FusionMode

from fusionkit_testkit.server import RouteKitSimulator


@dataclass(frozen=True)
class SimEndpoint:
    """Opaque endpoint identifier accepted by the simulated RouteKit gateway."""

    id: str


def sim_endpoint(
    _sim: RouteKitSimulator,
    *,
    id: str,
    model: str | None = None,
) -> SimEndpoint:
    """Create an opaque endpoint id; ``model`` is accepted for fixture readability."""

    del model
    return SimEndpoint(id=id)


def panel_config(
    sim: RouteKitSimulator,
    *,
    members: list[SimEndpoint],
    judge: SimEndpoint | None = None,
    synthesizer: SimEndpoint | None = None,
    default_mode: FusionMode = "panel",
) -> FusionConfig:
    """Build a production-shaped sidecar config over opaque endpoint ids."""

    endpoints = list(members)
    if judge is not None and judge not in endpoints:
        endpoints.append(judge)
    if synthesizer is not None and synthesizer not in endpoints:
        endpoints.append(synthesizer)
    first = members[0]
    return FusionConfig(
        routekit_url=sim.url,
        endpoint_ids=[endpoint.id for endpoint in endpoints],
        default_model=first.id,
        judge_model=(judge or first).id,
        synthesizer_model=(synthesizer or judge or first).id,
        default_mode=default_mode,
        panel_models=[member.id for member in members],
    )


__all__ = ["SimEndpoint", "panel_config", "sim_endpoint"]
