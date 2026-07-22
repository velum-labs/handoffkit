"""Archival no-op for the abandoned pre-lab hypergrid bring-up run."""

from __future__ import annotations

from typing import Any

from hyperkit import Experiment, experiment


@experiment(id="e001-hypergrid-bringup")
class HypergridBringup(Experiment):
    """The original grid remains at analysis/hypergrid/gen0.py."""

    def cells(self, ctx: Any):
        return ()
