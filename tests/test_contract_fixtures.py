from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def test_model_fusion_contract_fixtures_validate() -> None:
    module = _load_validator_module()
    summary = module.validate_contract_fixtures()

    assert summary.schema_count == 16
    assert summary.fixture_count == 32
    assert all(count == 2 for count in summary.fixture_counts.values())


def _load_validator_module() -> ModuleType:
    module_path = (
        Path(__file__).resolve().parents[1] / "scripts" / "validate_contract_fixtures.py"
    )
    spec = importlib.util.spec_from_file_location("validate_contract_fixtures", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
