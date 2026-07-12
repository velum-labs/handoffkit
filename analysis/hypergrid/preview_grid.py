"""Zero-spend preview of the generation-0 hypergrid: cells + cost estimates.

Usage: uv run python analysis/hypergrid/preview_grid.py [-o grid_preview.md]

Materializes the gen0 experiment cells (no adapter, no network, no spend),
then prints the grid with per-cell cost estimates from registry prices and
token assumptions declared in gen0.py. The kernel-probe rows are estimated
against placeholder top-2 solos (the screen decides the real ones).
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen0 import (  # noqa: E402
    ANCHORS,
    EST_INPUT_TOKENS,
    KERNEL_PROBES,
    OPEN_UNIVERSE,
    RUNG_PROBE,
    Gen0,
)


def estimate_cost(endpoint_id: str, tasks: int, calls_multiplier: float = 1.0) -> float:
    universe = {**OPEN_UNIVERSE, **ANCHORS}
    _, in_price, out_price, out_tokens = universe[endpoint_id]
    per_task = (EST_INPUT_TOKENS * in_price + out_tokens * out_price) / 1e6
    return per_task * tasks * calls_multiplier


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-o", "--output", type=Path, default=None)
    args = parser.parse_args()

    cells = list(Gen0().cells(ctx=None))
    out = io.StringIO()

    def emit(line: str = "") -> None:
        out.write(line + "\n")

    emit("# Generation-0 hypergrid preview (DRAFT -- no experiments started)")
    emit()
    emit(f"Materialized cells: {len(cells)} "
         f"({len(ANCHORS)} anchors + {len(OPEN_UNIVERSE)} open solos); "
         f"{sum(len(c.instances) for c in cells)} shards at the screen rung.")
    emit()
    emit("## Cells (from gen0.Gen0.cells)")
    emit()
    emit("| label | sut | model | instances | cell_id | est. cost |")
    emit("|---|---|---|---|---|---|")
    total = 0.0
    for cell in cells:
        endpoint_id = (cell.label or "").removeprefix("solo-")
        cost = estimate_cost(endpoint_id, len(cell.instances))
        total += cost
        emit(
            f"| {cell.label} | {cell.sut.kind} | {cell.sut.params.get('model')} "
            f"| {len(cell.instances)} | `{cell.cell_id}` | ${cost:.2f} |"
        )
    emit(f"\nSolo screen + anchors estimated total: **${total:.2f}**")

    emit()
    emit("## Kernel probes (gen 0b -- appended via `hyperkit extend` after the screen)")
    emit()
    emit("Panels below are placeholders; the screen's top-2 complementary solos"
         " replace them. Costed against a mid-price pair (ds32 + qwen3t).")
    emit()
    emit("| kernel | serve/params sketch | calls/task | instances | est. cost |")
    emit("|---|---|---|---|---|")
    pair = ["ds32", "qwen3t"]
    probe_total = 0.0
    for probe in KERNEL_PROBES:
        per_call = sum(estimate_cost(e, 1) for e in pair) / len(pair)
        cost = per_call * probe["calls_per_task"] * RUNG_PROBE
        probe_total += cost
        sketch = probe.get("serve") or probe.get("params")
        emit(
            f"| {probe['kernel']} | `{sketch}` | {probe['calls_per_task']} "
            f"| {RUNG_PROBE} | ${cost:.2f} |"
        )
    emit(f"\nKernel probes estimated total: **${probe_total:.2f}**")
    emit()
    emit(f"## Generation-0 grand total estimate: **${total + probe_total:.2f}** "
         f"(budget gate: $65)")
    emit()
    emit("Assumptions: input ~2k tokens/task; output tokens/task per endpoint as "
         "declared in gen0.OPEN_UNIVERSE (thinking models 12k, others 5-8k). "
         "Real spend is metered per shard via ShardResult.cost_usd.")

    text = out.getvalue()
    print(text)
    if args.output:
        args.output.write_text(text)
        print(f"[written to {args.output}]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
