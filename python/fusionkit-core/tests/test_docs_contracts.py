from pathlib import Path

from fusionkit_core.config import load_config

ROOT = Path(__file__).resolve().parents[3]


def test_documented_internal_fusion_configs_use_the_production_schema() -> None:
    for relative_path in (
        "configs/fusion.example.yaml",
        "configs/benchmark-panel.example.yaml",
        "configs/benchmark-panel.gpt-opus.yaml",
    ):
        config = load_config(ROOT / relative_path)
        assert config.routekit_model_ids
        assert config.default_model in config.routekit_model_ids
        assert config.judge_model in config.routekit_model_ids
