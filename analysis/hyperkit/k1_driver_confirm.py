"""Hyperkit replacement for the bespoke k1-swebench confirmation runners.

Materializes the same seed-45 30-instance comparison:
solo-terminus vs FusionKit driver-v2. Use:

  hyperkit plan analysis/hyperkit/k1_driver_confirm.py --workdir .hyperkit/k1-confirm
"""

from __future__ import annotations

from pathlib import Path

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "analysis" / "k1-swebench" / "3-driver" / "confirm_manifest.txt"
DRIVER_CONFIG = (
    ROOT / "analysis" / "k1-swebench" / "3-driver" / "config" / "driver-v2.yaml"
)


@experiment(id="k1-driver-confirm")
class K1DriverConfirm(Experiment):
    def cells(self, ctx):
        instances = ctx.manifest("swebench_verified", str(MANIFEST))
        dataset_hash = hash_ids(instances)
        yield Cell(
            sut=TopologySpec(
                kind="solo-model",
                params={"provider": "openrouter", "model": "deepseek/deepseek-v3.1-terminus"},
            ),
            benchmark="swebench_verified",
            instances=instances,
            manifest_ref=str(MANIFEST),
            dataset_hash=dataset_hash,
            label="solo-terminus",
        )
        yield Cell(
            sut=TopologySpec(
                kind="fusionkit-serve",
                params={
                    "workflow": "driver",
                    "config": str(DRIVER_CONFIG),
                    "k": 1,
                },
            ),
            benchmark="swebench_verified",
            instances=instances,
            manifest_ref=str(MANIFEST),
            dataset_hash=dataset_hash,
            label="driver-v2",
        )

