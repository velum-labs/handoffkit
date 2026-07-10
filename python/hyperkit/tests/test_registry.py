from __future__ import annotations

from pathlib import Path

from hyperkit.core.registry import (
    endpoint_identity_hash,
    lineage_conflicts,
    load_model_registry,
)

REPO = Path(__file__).resolve().parents[3]


def test_absorbed_model_registry_loads_and_hashes() -> None:
    registry = load_model_registry(REPO / "python" / "hyperkit" / "registry" / "2026-q3.yaml")
    assert registry.cycle_id == "2026-q3"
    terminus = registry.get("terminus")
    qwen = registry.get("qwen3t")
    assert terminus.model == "deepseek/deepseek-v3.1-terminus"
    assert len(endpoint_identity_hash(terminus)) == 16
    assert lineage_conflicts(terminus, qwen) is False
    assert lineage_conflicts(registry.get("r1"), terminus) is True

