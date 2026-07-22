"""Fusion benchmark presets kept outside the sidecar runtime."""

from __future__ import annotations

from typing import Any, cast

from fusionkit_evals._generated.benchmark_registry_data import BENCHMARK_REGISTRY

FUSION_GATEWAY_DEFAULT_BASE_URL = str(BENCHMARK_REGISTRY["gatewayDefaultBaseUrl"])
FUSION_GATEWAY_API_KEY_ENV = str(BENCHMARK_REGISTRY["gatewayApiKeyEnv"])

BENCHMARK_PANEL_PRESETS: dict[str, dict[str, Any]] = {
    panel_id: dict(cast(dict[str, Any], preset))
    for panel_id, preset in cast(
        dict[str, dict[str, Any]],
        BENCHMARK_REGISTRY["benchmarkPanels"],
    ).items()
}

__all__ = [
    "BENCHMARK_PANEL_PRESETS",
    "FUSION_GATEWAY_API_KEY_ENV",
    "FUSION_GATEWAY_DEFAULT_BASE_URL",
]
