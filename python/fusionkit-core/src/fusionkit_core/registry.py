"""Fusion-owned registry data used by the Python synthesis runtime."""

from __future__ import annotations

from typing import Any, cast

from fusionkit_core._generated.fusion_registry_data import FUSION_REGISTRY

_FUSION = cast(dict[str, Any], FUSION_REGISTRY["fusion"])

FUSION_MODEL_ALIASES: tuple[str, ...] = tuple(_FUSION["aliases"])
FUSION_DEFAULT_ALIAS: str = _FUSION["defaultAlias"]
FUSION_PANEL_ALIAS: str = _FUSION["panelAlias"]
FUSION_DEFAULT_MODE: str = _FUSION["defaultMode"]

_MODE_BY_SUFFIX = cast(dict[str, str], _FUSION["modeBySuffix"])


def fusion_mode_for_model(model: str) -> str:
    suffix = model.rsplit("/", maxsplit=1)[-1]
    return _MODE_BY_SUFFIX.get(suffix, FUSION_DEFAULT_MODE)


__all__ = [
    "FUSION_DEFAULT_ALIAS",
    "FUSION_DEFAULT_MODE",
    "FUSION_MODEL_ALIASES",
    "FUSION_PANEL_ALIAS",
    "fusion_mode_for_model",
]
