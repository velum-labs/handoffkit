"""Unit tests for the LiveCodeBench adapter's pure helpers (no billed calls)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import CostMetadata, FusionConfig, ModelEndpoint
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import FusionAnalysis, FusionResult, Trajectory

_ADAPTER_PATH = (
    Path(__file__).resolve().parents[1]
    / "python"
    / "fusionkit-evals"
    / "adapters"
    / "livecodebench_adapter.py"
)
_spec = importlib.util.spec_from_file_location("lcb_adapter_under_test", _ADAPTER_PATH)
assert _spec is not None and _spec.loader is not None
adapter = importlib.util.module_from_spec(_spec)
sys.modules["lcb_adapter_under_test"] = adapter
_spec.loader.exec_module(adapter)


def _engine() -> FusionEngine:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="gpt",
                model="m",
                base_url="http://x",
                pricing=CostMetadata(input_per_1m_tokens=1.0, output_per_1m_tokens=10.0),
            ),
            ModelEndpoint(
                id="opus",
                model="m",
                base_url="http://x",
                pricing=CostMetadata(input_per_1m_tokens=5.0, output_per_1m_tokens=25.0),
            ),
        ],
        default_model="gpt",
        panel_models=["gpt", "opus"],
        default_mode="panel",
    )
    return FusionEngine(
        config=config, clients={"gpt": FakeModelClient("gpt"), "opus": FakeModelClient("opus")}
    )


def _trajectory(model_id: str, ordinal: int = 0) -> Trajectory:
    return Trajectory(
        id=f"{model_id}:{ordinal}",
        model_id=model_id,
        content="```python\nprint(1)\n```",
        metadata={
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
            "latency_s": 2.0,
        },
    )


def test_stage_breakdown_prices_full_pipeline() -> None:
    """Regression: the judge/synth stage payloads carry extra keys (model_id,
    latency_s, skipped) that the usage contract rejects; pricing must not crash
    and must cover panel + judge + synthesis."""
    engine = _engine()
    result = FusionResult(
        mode="panel",
        content="fused",
        trajectories=[_trajectory("gpt"), _trajectory("opus")],
        metrics={
            "stage_metrics": {
                "judge": {
                    "prompt_tokens": 2000,
                    "completion_tokens": 200,
                    "total_tokens": 2200,
                    "latency_s": 1.5,
                    "model_id": "gpt",
                },
                "synthesis": {
                    "prompt_tokens": None,
                    "completion_tokens": None,
                    "total_tokens": None,
                    "model_id": "gpt",
                    "skipped": True,
                },
            }
        },
    )

    stages = adapter._stage_breakdown(engine, result)

    # panel: gpt 1000*1 + 100*10 = 0.002; opus 1000*5 + 100*25 = 0.0075 (per 1M)
    assert stages["cost_panel_usd"] == 0.0075 + 0.002
    assert stages["cost_judge_usd"] == (2000 * 1.0 + 200 * 10.0) / 1_000_000
    assert stages["cost_synth_usd"] is None  # skipped select-best synthesis
    assert stages["latency_judge_s"] == 1.5
    assert stages["cost_total_usd"] == stages["cost_panel_usd"] + stages["cost_judge_usd"]


def test_judge_pick_model_maps_trajectory_id() -> None:
    result = FusionResult(
        mode="panel",
        content="fused",
        trajectories=[_trajectory("gpt", 0), _trajectory("opus", 0)],
        analysis=FusionAnalysis(best_trajectory="opus:0"),
    )
    assert adapter._judge_pick_model(result) == "opus"
    result_no_pick = FusionResult(mode="panel", content="fused", trajectories=[])
    assert adapter._judge_pick_model(result_no_pick) is None
