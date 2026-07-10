from __future__ import annotations

from pathlib import Path

import hyperkit.adapters  # noqa: F401
from hyperkit.core.models import TopologySpec
from hyperkit.replay import ReplayRow, replay_reports

REPO = Path(__file__).resolve().parents[3]
ARM = REPO / "analysis" / "k1-swebench" / "3-driver"


def test_replay_reproduces_committed_fresh_confirmation(tmp_path: Path) -> None:
    """Migration gate: hyperkit reproduces the committed 19/30 vs 16/30 table.

    No provider calls, Docker, or benchmark execution -- this reads only the
    official harness report JSONs already committed by the k=1 program.
    """

    run = replay_reports(
        tmp_path,
        sweep_id="k1-driver-confirm-replay",
        benchmark="swebench_verified",
        manifest_ref=str(ARM / "confirm_manifest.txt"),
        rows=[
            ReplayRow(
                label="solo-terminus",
                sut=TopologySpec(kind="solo-model", params={"model": "terminus"}),
                report_path=ARM
                / "runs-confirm"
                / "solo-terminus"
                / "openrouter__deepseek__deepseek-v3.1-terminus.k1-3c-solo-terminus.json",
            ),
            ReplayRow(
                label="driver-v2",
                sut=TopologySpec(
                    kind="fusionkit-serve",
                    params={"workflow": "driver", "config": "driver-v2"},
                ),
                report_path=ARM
                / "runs-confirm"
                / "driver-v2"
                / "mini"
                / "openai__fusionkit__panel.k1-3c-driver-v2.json",
            ),
        ],
    )
    rows = {row["label"]: row for row in run.cells}
    assert rows["solo-terminus"]["resolved"] == 19
    assert rows["driver-v2"]["resolved"] == 16
    assert rows["solo-terminus"]["n_graded"] == 30
    assert rows["driver-v2"]["n_graded"] == 30

