"""Compute the round-1 comparison table from terminal-bench results.json files.

Reads the newest run under each of runs/solo-terminus, runs/solo-qwen3,
runs/fused; recomputes everything from the per-trial rows (never from stdout),
per the program's trust-but-recompute rule.

Usage: uv run python analysis/k1-round1/scripts/analyze_round1.py
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


def load_outcomes(run_name: str) -> dict[str, bool]:
    run_root = ROUND_DIR / "runs" / run_name
    candidates = sorted(p for p in run_root.glob("*/results.json"))
    if not candidates:
        raise FileNotFoundError(f"no results.json under {run_root}")
    results = json.loads(candidates[-1].read_text())
    outcomes: dict[str, bool] = {}
    for row in results["results"]:
        task_id = row["task_id"]
        outcomes[task_id] = bool(row["is_resolved"])
    return outcomes


def main() -> int:
    outcomes = {name: load_outcomes(name) for name in RUNS}
    tasks = sorted(outcomes["fused"])
    for name, rows in outcomes.items():
        if sorted(rows) != tasks:
            raise SystemExit(f"task set mismatch in {name}: {sorted(rows)} != {tasks}")

    n = len(tasks)
    solo_names = [r for r in RUNS if r != "fused"]
    per_run_pass = {name: sum(outcomes[name][t] for t in tasks) for name in RUNS}
    oracle_pass = sum(any(outcomes[s][t] for s in solo_names) for t in tasks)
    best_solo_name = max(solo_names, key=lambda s: per_run_pass[s])

    print(f"tasks: n={n}")
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
    print(f"headroom (oracle - best solo): {headroom:+d} tasks ({headroom / n:+.1%})")
    print(f"fused - best solo: {fused - best:+d} tasks ({(fused - best) / n:+.1%})")
    if headroom > 0:
        print(f"capture: {(fused - best) / headroom:.0%}")
    print("\nper-task grid (1=resolved):")
    print(f"{'task':<40}" + "".join(f"{name:>15}" for name in [*solo_names, 'fused']))
    for t in tasks:
        cells = "".join(f"{int(outcomes[name][t]):>15}" for name in [*solo_names, "fused"])
        print(f"{t:<40}{cells}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
