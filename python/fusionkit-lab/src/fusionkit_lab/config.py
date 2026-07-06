"""Lab configuration resolves local state without baking machine paths into runs.

The lab writes large, mutable artifacts outside git while keeping small manifests
in the repository. This module centralizes the repo-relative defaults and the few
environment overrides needed to move those artifacts in CI or local experiments.
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

DEFAULT_CYCLE_ID = "2026-q3"
LAB_ROOT_ENV = "FUSIONKIT_LAB_ROOT"
REGISTRY_DIR_ENV = "FUSIONKIT_LAB_REGISTRY_DIR"


class LabConfig(BaseModel):
    labdata_root: Path = Field(default_factory=lambda: _default_labdata_root_default())
    cycle_id: str = DEFAULT_CYCLE_ID
    screen_max_spend_usd: float = 150.0
    fill_max_spend_usd: float = 800.0
    search_max_spend_usd: float = 200.0
    confirm_max_spend_usd: float = 300.0
    registry_dir: Path = Field(default_factory=lambda: _default_registry_dir_default())

    @field_validator("labdata_root", "registry_dir", mode="after")
    @classmethod
    def _resolve_paths(cls, value: Path) -> Path:
        return value.expanduser().resolve(strict=False)


def load_lab_config(
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> LabConfig:
    effective_env = env if env is not None else os.environ
    effective_cwd = cwd if cwd is not None else Path.cwd()
    return LabConfig(
        labdata_root=_default_labdata_root(effective_cwd, effective_env),
        registry_dir=_default_registry_dir(effective_cwd, effective_env),
    )


def _default_labdata_root_default() -> Path:
    return _default_labdata_root(Path.cwd(), os.environ)


def _default_registry_dir_default() -> Path:
    return _default_registry_dir(Path.cwd(), os.environ)


def find_repo_root(start: Path | None = None) -> Path:
    current = (start if start is not None else Path.cwd()).expanduser().resolve(strict=False)
    if current.is_file():
        current = current.parent

    for candidate in (current, *current.parents):
        pyproject = candidate / "pyproject.toml"
        if pyproject.exists() and _has_uv_workspace(pyproject):
            return candidate

    raise FileNotFoundError(f"could not find uv workspace root from {current}")


def _default_labdata_root(cwd: Path, env: Mapping[str, str]) -> Path:
    repo_root = find_repo_root(cwd)
    override = env.get(LAB_ROOT_ENV)
    if override:
        return _resolve_path(override, cwd)
    return repo_root / "labdata"


def _default_registry_dir(cwd: Path, env: Mapping[str, str]) -> Path:
    repo_root = find_repo_root(cwd)
    override = env.get(REGISTRY_DIR_ENV)
    if override:
        return _resolve_path(override, cwd)
    return repo_root / "python" / "fusionkit-lab" / "registry"


def _resolve_path(raw_path: str, cwd: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve(strict=False)


def _has_uv_workspace(pyproject: Path) -> bool:
    try:
        data: dict[str, Any] = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return False

    tool = data.get("tool")
    if not isinstance(tool, dict):
        return False
    uv = tool.get("uv")
    if not isinstance(uv, dict):
        return False
    return isinstance(uv.get("workspace"), dict)


__all__ = [
    "DEFAULT_CYCLE_ID",
    "LAB_ROOT_ENV",
    "REGISTRY_DIR_ENV",
    "LabConfig",
    "find_repo_root",
    "load_lab_config",
]
