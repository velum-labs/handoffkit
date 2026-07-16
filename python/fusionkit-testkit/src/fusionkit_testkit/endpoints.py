"""Config builders that point the neutral RouteKit client at the simulator."""

from __future__ import annotations

from dataclasses import dataclass

from fusionkit_core.config import FusionConfig, FusionMode

from fusionkit_testkit.server import RouteKitSimulator


@dataclass(frozen=True)
class SimModel:
    """Namespaced model identifier accepted by the simulated RouteKit gateway."""

    id: str


def sim_model(
    _sim: RouteKitSimulator,
    *,
    id: str,
    model: str | None = None,
) -> SimModel:
    """Create a RouteKit model id; ``model`` is accepted for fixture readability."""

    del model
    return SimModel(id=id)


def panel_config(
    sim: RouteKitSimulator,
    *,
    members: list[SimModel],
    judge: SimModel | None = None,
    synthesizer: SimModel | None = None,
    default_mode: FusionMode = "panel",
) -> FusionConfig:
    """Build a production-shaped sidecar config over namespaced RouteKit model ids."""

    models = list(members)
    if judge is not None and judge not in models:
        models.append(judge)
    if synthesizer is not None and synthesizer not in models:
        models.append(synthesizer)
    first = members[0]
    return FusionConfig(
        routekit_url=sim.url,
        routekit_model_ids=[model.id for model in models],
        default_model=first.id,
        judge_model=(judge or first).id,
        synthesizer_model=(synthesizer or judge or first).id,
        default_mode=default_mode,
        panel_models=[member.id for member in members],
    )


__all__ = ["SimModel", "panel_config", "sim_model"]
