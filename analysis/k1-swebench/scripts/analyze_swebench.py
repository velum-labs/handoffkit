"""Compute the SWE-bench arm comparison table from official harness reports.

Reads each row's swebench evaluation report (written by
``swebench.harness.run_evaluation`` next to the row's preds.json as
``<model>.k1-<row>.json``) and recomputes everything from the reports' resolved
id lists — never from stdout.

Usage: uv run python analysis/k1-swebench/scripts/analyze_swebench.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROUND_DIR = Path(__file__).resolve().parents[1]
RUNS = ["solo-terminus", "solo-qwen3", "fused"]


def wilson_interval(successes: int, total: int, z: float = 1.96) -> tuple[float, float]:
    if total == 0:
        return (0.0, 0.0)
    p = successes / total
    denom = 1 + z**2 / total
    center = (p + z**2 / (2 * total)) / denom
    margin = z * math.sqrt(p * (1 - p) / total + z**2 / (4 * total**2)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def load_report(run_name: str) -> tuple[set[str], set[str]]:
    """Return (submitted_ids, resolved_ids) from the row's evaluation report."""
    run_dir = ROUND_DIR / "runs" / run_name
    reports = sorted(run_dir.glob(f"*.k1-{run_name}.json"))
    if not reports:
        raise FileNotFoundError(f"no swebench report *.k1-{run_name}.json under {run_dir}")
    report = json.loads(reports[-1].read_text())
    submitted = set(report.get("submitted_ids", []))
    resolved = set(report.get("resolved_ids", []))
    return submitted, resolved


def main() -> int:
    manifest = [
        line
        for line in (ROUND_DIR / "instance_manifest.txt").read_text().splitlines()
        if line and not line.startswith("#")
    ]
    tasks = sorted(manifest)
    n = len(tasks)

    resolved: dict[str, set[str]] = {}
    for name in RUNS:
        submitted, resolved_ids = load_report(name)
        missing = set(tasks) - submitted
        if missing:
            print(f"WARNING: {name} missing submissions for {sorted(missing)}")
        resolved[name] = resolved_ids & set(tasks)

    solo_names = [r for r in RUNS if r != "fused"]
    per_run_pass = {name: len(resolved[name]) for name in RUNS}
    oracle_ids = set().union(*(resolved[s] for s in solo_names))
    oracle_pass = len(oracle_ids)
    best_solo_name = max(solo_names, key=lambda s: per_run_pass[s])

    print(f"instances: n={n}")
    print(f"{'row':<16}{'resolved':>10}{'rate':>8}  wilson95")
    for name in [*solo_names, "fused"]:
        k = per_run_pass[name]
        lo, hi = wilson_interval(k, n)
        print(f"{name:<16}{k:>7}/{n:<3}{k / n:>7.1%}  [{lo:.1%}, {hi:.1%}]")
    lo, hi = wilson_interval(oracle_pass, n)
    print(f"{'oracle(solo)':<16}{oracle_pass:>7}/{n:<3}{oracle_pass / n:>7.1%}  [{lo:.1%}, {hi:.1%}]")

    best, fused = per_run_pass[best_solo_name], per_run_pass["fused"]
    headroom = oracle_pass - best
    print(f"\nbest solo: {best_solo_name} ({best}/{n})")
    print(f"headroom (oracle - best solo): {headroom:+d} instances ({headroom / n:+.1%})")
    print(f"fused - best solo: {fused - best:+d} instances ({(fused - best) / n:+.1%})")
    if headroom > 0:
        print(f"capture: {(fused - best) / headroom:.0%}")
    print("\nper-instance grid (1=resolved):")
    print(f"{'instance':<44}" + "".join(f"{name:>15}" for name in [*solo_names, 'fused']))
    for t in tasks:
        cells = "".join(f"{int(t in resolved[name]):>15}" for name in [*solo_names, "fused"])
        print(f"{t:<44}{cells}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
