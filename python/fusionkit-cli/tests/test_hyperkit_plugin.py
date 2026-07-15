from pathlib import Path

from fusionkit_cli.hyperkit_plugin import FusionKitServeSUT
from hyperkit.core.models import TopologySpec


def test_target_model_follows_materialized_default_mode(tmp_path: Path) -> None:
    config = tmp_path / "fusionkit.yaml"
    config.write_text("default_mode: self\n", encoding="utf-8")
    spec = TopologySpec(kind="fusionkit-serve")

    assert FusionKitServeSUT()._target_model(spec, config) == "fusionkit/self"


def test_target_model_explicit_override_wins(tmp_path: Path) -> None:
    config = tmp_path / "fusionkit.yaml"
    config.write_text("default_mode: self\n", encoding="utf-8")
    spec = TopologySpec(
        kind="fusionkit-serve",
        params={"model": "fusionkit/panel"},
    )

    assert FusionKitServeSUT()._target_model(spec, config) == "fusionkit/panel"
