"""Hyperkit replacement for analysis/k1-round1's bespoke Terminal-Bench runner."""

from __future__ import annotations

from pathlib import Path

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "analysis" / "k1-round1" / "task_manifest.txt"
PANEL_CONFIG = ROOT / "analysis" / "k1-round1" / "config" / "panel.yaml"


@experiment(id="k1-terminal-round1")
class K1TerminalRound1(Experiment):
    def cells(self, ctx):
        instances = ctx.manifest("terminal_bench", str(MANIFEST))
        dataset_hash = hash_ids(instances)
        for label, model in (
            ("solo-terminus", "deepseek/deepseek-v3.1-terminus"),
            ("solo-qwen3", "qwen/qwen3-coder"),
        ):
            yield Cell(
                sut=TopologySpec(
                    kind="solo-model",
                    params={"provider": "openrouter", "model": model},
                ),
                benchmark="terminal_bench",
                instances=instances,
                manifest_ref=str(MANIFEST),
                dataset_hash=dataset_hash,
                label=label,
            )
        yield Cell(
            sut=TopologySpec(
                kind="fusionkit-serve",
                params={
                    "workflow": "panel-judge-synth",
                    "config": str(PANEL_CONFIG),
                    "k": 1,
                },
            ),
            benchmark="terminal_bench",
            instances=instances,
            manifest_ref=str(MANIFEST),
            dataset_hash=dataset_hash,
            label="fused",
        )

