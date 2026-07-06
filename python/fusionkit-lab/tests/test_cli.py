"""CLI tests prove the Stage 0 entry point is read-only and scriptable."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fusionkit_lab.cli import main
from fusionkit_lab.config import LAB_ROOT_ENV, REGISTRY_DIR_ENV

PACKAGE_ROOT = Path(__file__).parents[1]
REGISTRY_DIR = PACKAGE_ROOT / "registry"


def test_models_list_contains_committed_endpoints(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv(REGISTRY_DIR_ENV, str(REGISTRY_DIR))

    code = main(["models", "list", "--cycle", "2026-q3"])

    captured = capsys.readouterr()
    assert code == 0
    assert "r1" in captured.out
    assert "terminus" in captured.out
    assert "qwen3t" in captured.out


def test_models_show_unknown_endpoint_returns_nonzero(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv(REGISTRY_DIR_ENV, str(REGISTRY_DIR))

    code = main(["models", "show", "missing"])

    captured = capsys.readouterr()
    assert code != 0
    assert "unknown endpoint_id 'missing'" in captured.err


def test_config_prints_valid_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    lab_root = tmp_path / "labdata"
    monkeypatch.setenv(LAB_ROOT_ENV, str(lab_root))

    code = main(["config"])

    captured = capsys.readouterr()
    assert code == 0
    payload = json.loads(captured.out)
    assert payload["labdata_root"] == str(lab_root)
    assert payload["cycle_id"] == "2026-q3"
