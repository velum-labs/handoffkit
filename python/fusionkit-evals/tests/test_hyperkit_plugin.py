from __future__ import annotations

import json
from importlib.metadata import entry_points

import pytest
import yaml
from fusionkit_evals.hyperkit_plugin import FusionKitGatewaySUT
from hyperkit.core.models import TopologySpec


def test_hyperkit_plugin_entrypoint_is_owned_by_fusionkit_evals() -> None:
    entrypoint = next(
        entrypoint
        for entrypoint in entry_points(group="hyperkit.suts")
        if entrypoint.name == "fusionkit-serve"
    )
    assert entrypoint.value == "fusionkit_evals.hyperkit_plugin:factory"


def test_hyperkit_plugin_materializes_node_owned_configs(tmp_path) -> None:
    fusion_config = {
        "version": "fusionkit.fusion.v4",
        "router": {"config": ".routekit/router.yaml"},
        "defaultEnsemble": "default",
        "ensembles": {
            "default": {
                "members": ["opaque-a"],
                "judge": "opaque-a",
                "synthesizer": "opaque-a",
            }
        },
    }
    routekit_config = {"version": "routekit.router.v1", "endpoints": []}

    project = FusionKitGatewaySUT()._materialize_project(
        TopologySpec(
            kind="fusionkit-serve",
            params={
                "fusion_config": fusion_config,
                "routekit_config": routekit_config,
            },
        ),
        tmp_path,
    )

    assert json.loads((project / ".fusionkit/fusion.json").read_text()) == fusion_config
    assert yaml.safe_load((project / ".routekit/router.yaml").read_text()) == routekit_config


def test_hyperkit_plugin_rejects_removed_python_provider_schema(tmp_path) -> None:
    with pytest.raises(ValueError, match="removed Python provider schema"):
        FusionKitGatewaySUT()._materialize_project(
            TopologySpec(
                kind="fusionkit-serve",
                params={"serve_config": {"endpoints": [{"provider": "openai"}]}},
            ),
            tmp_path,
        )
