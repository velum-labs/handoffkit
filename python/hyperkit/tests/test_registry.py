from __future__ import annotations

from pathlib import Path

import pytest
from hyperkit.core.registry import (
    endpoint_identity_hash,
    lineage_conflicts,
    load_model_registry,
    require_verified_open_weight,
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


def test_registry_contains_phase_a_shortlist() -> None:
    """Stage 0 bridge models stay first; Phase A appends the shortlist identities."""

    registry = load_model_registry(REPO / "python" / "hyperkit" / "registry" / "2026-q3.yaml")
    endpoint_ids = list(registry.endpoints)
    assert endpoint_ids[:3] == ["r1", "terminus", "qwen3t"]
    assert {"ds32", "nemotron3s", "dsv4pro", "glm52", "qwen37max"}.issubset(endpoint_ids)
    assert registry.get("qwen37max").weight_eligibility == "proprietary"
    assert [
        endpoint.id
        for endpoint in require_verified_open_weight(
            registry,
            ["dsv4pro", "qwen3t", "glm52"],
        )
    ] == ["dsv4pro", "qwen3t", "glm52"]
    with pytest.raises(ValueError, match="qwen37max"):
        require_verified_open_weight(registry, ["qwen37max"])


def test_identity_hash_changes_when_model_changes() -> None:
    registry = load_model_registry(REPO / "python" / "hyperkit" / "registry" / "2026-q3.yaml")
    r1 = registry.get("r1")

    changed = r1.model_copy(update={"model": "deepseek/deepseek-r1-0528-rev2"})

    assert endpoint_identity_hash(changed) != endpoint_identity_hash(r1)

