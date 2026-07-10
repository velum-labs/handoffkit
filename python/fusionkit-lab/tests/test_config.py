"""Config tests keep repo-relative defaults stable across local and CI runs."""

from __future__ import annotations

from pathlib import Path

from fusionkit_lab.config import LAB_ROOT_ENV, load_lab_config


def test_config_defaults_from_uv_workspace_root(tmp_path: Path) -> None:
    repo_root = _make_workspace(tmp_path)
    cwd = repo_root / "python" / "fusionkit-lab"
    cwd.mkdir(parents=True)

    config = load_lab_config(env={}, cwd=cwd)

    assert config.labdata_root == repo_root / "labdata"
    assert config.cycle_id == "2026-q3"
    assert config.screen_max_spend_usd == 150.0
    assert config.fill_max_spend_usd == 800.0
    assert config.search_max_spend_usd == 200.0
    assert config.confirm_max_spend_usd == 300.0
    assert config.registry_dir == repo_root / "python" / "fusionkit-lab" / "registry"


def test_labdata_root_env_override(tmp_path: Path) -> None:
    repo_root = _make_workspace(tmp_path)
    cwd = repo_root / "python"
    cwd.mkdir()
    override = tmp_path / "custom-labdata"

    config = load_lab_config(env={LAB_ROOT_ENV: str(override)}, cwd=cwd)

    assert config.labdata_root == override


def _make_workspace(tmp_path: Path) -> Path:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    repo_root.joinpath("pyproject.toml").write_text(
        '[tool.uv.workspace]\nmembers = ["python/*"]\n',
        encoding="utf-8",
    )
    return repo_root.resolve(strict=False)
