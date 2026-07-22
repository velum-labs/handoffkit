"""Truncation-fair re-screen of the seven models e002 measured under a
reasoning-hostile 16384-token cap (see the e002 erratum of 2026-07-15)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[3]
DEV_MANIFEST = ROOT / "analysis" / "hypergrid" / "manifests" / "dev.txt"
BENCHMARK = "livecodebench"

# Models whose providers count reasoning tokens against max_tokens; budgets
# follow the registry's escalated 64k tier so thinking never hits the cap.
RESCREEN = {
    "r1": "deepseek/deepseek-r1-0528",
    "kimikt": "moonshotai/kimi-k2-thinking",
    "kimi26": "moonshotai/kimi-k2.6",
    "glm52": "z-ai/glm-5.2",
    "nemotron3s": "nvidia/nemotron-3-super-120b-a12b",
    "dsv4pro": "deepseek/deepseek-v4-pro",
    "qwen3t": "qwen/qwen3-235b-a22b-thinking-2507",
}

# 2x1500 s stays under the 3600 s Batch wall clock with grading headroom.
HARNESS = {"max_tokens": 65536, "request_timeout_s": 1500.0, "attempts": 2}


def _instances() -> list[str]:
    return [
        line.strip()
        for line in DEV_MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]


@experiment(id="e004-truncation-fair-rescreen")
class TruncationFairRescreen(Experiment):
    def cells(self, ctx: Any):
        instances = _instances()
        dataset_hash = hash_ids(instances)
        for endpoint_id, model in sorted(RESCREEN.items()):
            yield Cell(
                sut=TopologySpec(
                    kind="solo-model",
                    params={"provider": "openrouter", "model": model},
                ),
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                params=dict(HARNESS),
                label=f"solo64k-{endpoint_id}",
            )
