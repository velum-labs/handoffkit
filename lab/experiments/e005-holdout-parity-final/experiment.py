"""Locked-holdout final: solo qwen3.7-max against both frozen anchors, once.

The campaign's one claim (e002/e004): qwen3.7-max reached GPT-5.5 parity on
the dev slice and no open compound adds headroom. This evaluates that claim a
single time on the never-touched holdout manifest.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[3]
HOLDOUT_MANIFEST = ROOT / "analysis" / "hypergrid" / "manifests" / "holdout.txt"
EXCLUSIONS = ROOT / "analysis" / "hypergrid" / "manifests" / "special_judge_exclusions.txt"
BENCHMARK = "livecodebench"

FINALISTS = {
    "final-q37max": "qwen/qwen3.7-max",
    "final-anchor-gpt55": "openai/gpt-5.5",
    "final-anchor-opus48": "anthropic/claude-opus-4.8",
}

HARNESS = {"max_tokens": 65536, "request_timeout_s": 1500.0, "attempts": 2}


def _instances() -> list[str]:
    excluded = {
        line.strip()
        for line in EXCLUSIONS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    return [
        line.strip()
        for line in HOLDOUT_MANIFEST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#") and line.strip() not in excluded
    ]


@experiment(id="e005-holdout-parity-final")
class HoldoutParityFinal(Experiment):
    def cells(self, ctx: Any):
        instances = _instances()
        dataset_hash = hash_ids(instances)
        for label, model in sorted(FINALISTS.items()):
            yield Cell(
                sut=TopologySpec(
                    kind="solo-model",
                    params={"provider": "openrouter", "model": model},
                ),
                benchmark=BENCHMARK,
                instances=instances,
                manifest_ref=str(HOLDOUT_MANIFEST),
                dataset_hash=dataset_hash,
                params=dict(HARNESS),
                label=label,
            )
