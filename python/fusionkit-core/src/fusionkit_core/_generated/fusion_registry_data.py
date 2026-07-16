# GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. Regenerate with `node scripts/generate-registry.mjs`.
# ruff: noqa: E501
from __future__ import annotations

from typing import Any, Final

FUSION_REGISTRY: Final[dict[str, Any]] = {
    "fusion": {
        "aliases": [
            "fusionkit/heuristic",
            "fusionkit/panel",
            "fusionkit/self",
            "fusionkit/single",
        ],
        "defaultAlias": "fusionkit/heuristic",
        "panelAlias": "fusionkit/panel",
        "modeBySuffix": {
            "single": "single",
            "self": "self",
            "panel": "panel",
            "heuristic": "heuristic",
        },
        "defaultMode": "heuristic",
    },
}
