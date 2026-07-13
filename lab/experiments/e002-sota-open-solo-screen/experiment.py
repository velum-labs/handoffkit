"""Frozen SOTA-anchor and open-weight solo screen for hypergrid e002."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[3]
DEV_MANIFEST = ROOT / "analysis" / "hypergrid" / "manifests" / "dev.txt"
BENCHMARK = "livecodebench"

# Closed yardsticks are measured only as solo cells and are never available to
# a compound builder.
ANCHOR_MODELS = {
    "anchor-gpt55": "openai/gpt-5.5",
    "anchor-opus48": "anthropic/claude-opus-4.8",
}

# The complete open-weight universe preregistered in analysis/hypergrid/PLAN.md.
OPEN_MODELS = {
    "ds32": "deepseek/deepseek-v3.2",
    "dsv4pro": "deepseek/deepseek-v4-pro",
    "terminus": "deepseek/deepseek-v3.1-terminus",
    "r1": "deepseek/deepseek-r1-0528",
    "qwen3t": "qwen/qwen3-235b-a22b-thinking-2507",
    "qwen37max": "qwen/qwen3.7-max",
    "glm52": "z-ai/glm-5.2",
    "kimi26": "moonshotai/kimi-k2.6",
    "nemotron3s": "nvidia/nemotron-3-super-120b-a12b",
    "kimikt": "moonshotai/kimi-k2-thinking",
    "qwen3c": "qwen/qwen3-coder",
}


def _instances() -> list[str]:
    return [
        line.strip()
        for line in DEV_MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]


def _solo(model: str) -> TopologySpec:
    return TopologySpec(
        kind="solo-model",
        params={"provider": "openrouter", "model": model},
    )


@experiment(id="e002-sota-open-solo-screen")
class SotaOpenSoloScreen(Experiment):
    def cells(self, ctx: Any):
        instances = _instances()
        dataset_hash = hash_ids(instances)

        for label, model in sorted(ANCHOR_MODELS.items()):
            yield Cell(
                sut=_solo(model),
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                label=label,
            )
        for endpoint_id, model in sorted(OPEN_MODELS.items()):
            yield Cell(
                sut=_solo(model),
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(DEV_MANIFEST),
                dataset_hash=dataset_hash,
                label=f"solo-{endpoint_id}",
            )
