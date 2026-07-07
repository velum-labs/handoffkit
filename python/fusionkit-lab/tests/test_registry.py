"""Registry tests pin the Stage 0 contract before paid runners depend on it."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fusionkit_lab.registry import (
    ModelRegistry,
    identity_hash,
    lineage_conflicts,
    load_registry,
)
from pydantic import ValidationError

PACKAGE_ROOT = Path(__file__).parents[1]
REGISTRY_PATH = PACKAGE_ROOT / "registry" / "2026-q3.yaml"


def test_committed_registry_round_trips() -> None:
    registry = load_registry(REGISTRY_PATH)

    assert registry.cycle_id == "2026-q3"
    endpoint_ids = [model.endpoint_id for model in registry.models]
    # Bridge models from Stage 0 stay first; Phase A appends current-generation
    # shortlist identities after them.
    assert endpoint_ids[:3] == ["r1", "terminus", "qwen3t"]
    assert {"ds32", "nemotron3s", "dsv4pro", "glm52", "qwen37max"}.issubset(endpoint_ids)

    dumped = registry.model_dump(mode="json")
    assert ModelRegistry.model_validate(dumped) == registry


def test_identity_hash_is_stable() -> None:
    registry = load_registry(REGISTRY_PATH)
    assert identity_hash(registry.get("r1")) == "903aaa8daf7e7c2a"


def test_identity_hash_changes_when_model_changes() -> None:
    registry = load_registry(REGISTRY_PATH)
    r1 = registry.get("r1")

    changed = r1.model_copy(update={"model": "deepseek/deepseek-r1-0528-rev2"})

    assert identity_hash(changed) != identity_hash(r1)


def test_lineage_conflicts_detect_shared_lineage() -> None:
    registry = load_registry(REGISTRY_PATH)

    assert lineage_conflicts(registry.get("r1"), registry.get("terminus"))
    assert not lineage_conflicts(registry.get("r1"), registry.get("qwen3t"))


def test_duplicate_endpoint_id_is_rejected(tmp_path: Path) -> None:
    registry = load_registry(REGISTRY_PATH)
    data = registry.model_dump(mode="json")
    data["models"][1]["endpoint_id"] = "r1"
    duplicate_path = tmp_path / "duplicate.yaml"
    duplicate_path.write_text(yaml.safe_dump(data), encoding="utf-8")

    with pytest.raises(ValidationError, match="duplicate endpoint_id"):
        load_registry(duplicate_path)


def test_unknown_endpoint_raises_helpful_key_error() -> None:
    registry = load_registry(REGISTRY_PATH)

    with pytest.raises(KeyError, match="unknown endpoint_id 'missing'"):
        registry.get("missing")
