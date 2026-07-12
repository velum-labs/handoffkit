"""End-to-end smoke for the hypergrid stack (3 tiny cells, ~$0.05).

Exercises all three execution paths before generation 0: solo-model via
OpenRouter, fusionkit-serve judge+synth, and the adapter's exec-select kernel.

  uv run hyperkit plan analysis/hypergrid/smoke.py --workdir .hyperkit/smoke
  uv run hyperkit apply --workdir .hyperkit/smoke --backend local
  uv run hyperkit collect --workdir .hyperkit/smoke
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from hyperkit import Cell, Experiment, TopologySpec, experiment
from hyperkit.core.ids import hash_ids

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen0 import DEV_MANIFEST, build_serve_config, solo_endpoint_params  # noqa: E402

BENCHMARK = "livecodebench"


def _dev_instances() -> list[str]:
    lines = DEV_MANIFEST.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]


@experiment(id="hypergrid-smoke")
class Smoke(Experiment):
    def cells(self, ctx: Any):
        instances = _dev_instances()
        dataset_hash = hash_ids(instances)
        yield Cell(
            sut=TopologySpec(kind="solo-model", params=solo_endpoint_params("ds32")),
            benchmark=BENCHMARK,
            instances=instances[:3],
            manifest_ref=str(DEV_MANIFEST),
            dataset_hash=dataset_hash,
            label="smoke-solo-ds32",
        )
        yield Cell(
            sut=TopologySpec(
                kind="fusionkit-serve",
                params={
                    "serve_config": build_serve_config(
                        ["ds32", "qwen3t"], judge="qwen3t", synthesizer="qwen3t"
                    )
                },
            ),
            benchmark=BENCHMARK,
            instances=instances[:3],
            manifest_ref=str(DEV_MANIFEST),
            dataset_hash=dataset_hash,
            params={"panel": ["ds32", "qwen3t"], "topology": "judge-synth"},
            label="smoke-fused-judge-synth",
        )
        yield Cell(
            sut=TopologySpec(kind="solo-model", params=solo_endpoint_params("ds32")),
            benchmark=BENCHMARK,
            instances=instances[:3],
            manifest_ref=str(DEV_MANIFEST),
            dataset_hash=dataset_hash,
            params={
                "n_samples": 2,
                "temps": [0.2, 0.8],
                "selection": "public-exec",
                "topology": "exec-select",
            },
            label="smoke-exec-select-ds32",
        )
