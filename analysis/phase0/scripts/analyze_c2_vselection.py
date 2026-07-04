from __future__ import annotations

import csv
import itertools
from pathlib import Path
from typing import Any

from analyze_c1_c2 import (
    BOOTSTRAPS,
    SEED,
    MatrixData,
    build_all_data,
    clustered_ci,
    common_tasks,
    feasible_combo,
    fmt_ci,
    fmt_pp,
    md_table,
    mean_on_tasks,
    oracle_on_tasks,
    split_clusters,
    tasks_for_clusters,
    topk_by_average,
)

OUT = Path("/workspace/analysis/phase0")
PREREG = OUT / "c2v_preregistration.md"
REPORT = OUT / "c2v_report.md"
RESULTS = OUT / "c2v_results.csv"
CAPTURE_PRIMARY = 0.7
CAPTURE_SENSITIVITY = (0.5, 0.9)
EXPECTED_SYSTEM_COUNTS = {
    "swe_verified": 72,
    "swe_test": 6,
    "terminalbench": 109,
    "llmrouterbench_livecodebench": 37,
    "llmrouterbench_swebench": 14,
    "llmrouterbench_mbpp": 20,
    "llmrouterbench_humaneval": 22,
}


def best_pass_on_tasks(data: MatrixData, panel: list[str], tasks: list[str]) -> float:
    return max(mean_on_tasks(data.y, system, tasks) for system in panel) if tasks else float("nan")


def headroom_on_tasks(data: MatrixData, panel: list[str], tasks: list[str]) -> float:
    if not tasks:
        return float("nan")
    return oracle_on_tasks(data.y, panel, tasks) - best_pass_on_tasks(data, panel, tasks)


def panel_value(data: MatrixData, panel: list[str], tasks: list[str], capture: float) -> float:
    if not tasks:
        return float("nan")
    best_pass = best_pass_on_tasks(data, panel, tasks)
    return best_pass + capture * (oracle_on_tasks(data.y, panel, tasks) - best_pass)


def panel_sort_key(data: MatrixData, combo: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(data.systems[system].display_name for system in combo)


def is_better_panel(
    data: MatrixData,
    combo: tuple[str, ...],
    score: float,
    oracle: float,
    best_single: float,
    best_combo: tuple[str, ...] | None,
    best_score: float,
    best_oracle: float,
    incumbent_best_single: float,
) -> bool:
    if best_combo is None:
        return True
    if score > best_score + 1e-12:
        return True
    if abs(score - best_score) > 1e-12:
        return False
    if oracle > best_oracle + 1e-12:
        return True
    if abs(oracle - best_oracle) > 1e-12:
        return False
    if best_single > incumbent_best_single + 1e-12:
        return True
    if abs(best_single - incumbent_best_single) > 1e-12:
        return False
    return panel_sort_key(data, combo) < panel_sort_key(data, best_combo)


def exhaustive_select_v(
    data: MatrixData,
    candidates: list[str],
    k: int,
    tasks: list[str],
    capture: float,
) -> tuple[list[str], float]:
    best_combo: tuple[str, ...] | None = None
    best_score = -1.0
    best_oracle = -1.0
    best_pass = -1.0
    for combo in itertools.combinations(candidates, k):
        if not feasible_combo(combo, data.systems):
            continue
        combo_tasks = [task for task in tasks if all(task in data.y[system] for system in combo)]
        if not combo_tasks:
            continue
        score = panel_value(data, list(combo), combo_tasks, capture)
        oracle = oracle_on_tasks(data.y, combo, combo_tasks)
        best_single = best_pass_on_tasks(data, list(combo), combo_tasks)
        if is_better_panel(
            data,
            combo,
            score,
            oracle,
            best_single,
            best_combo,
            best_score,
            best_oracle,
            best_pass,
        ):
            best_combo = combo
            best_score = score
            best_oracle = oracle
            best_pass = best_single
    return list(best_combo or []), best_score


def validate_source_universe(data_sets: list[MatrixData]) -> None:
    observed = {data.source_id: len(data.systems) for data in data_sets}
    if observed != EXPECTED_SYSTEM_COUNTS:
        raise RuntimeError(
            "source universe count mismatch: "
            f"expected {EXPECTED_SYSTEM_COUNTS}, observed {observed}"
        )


def assert_unique_base(data: MatrixData, panel: list[str], label: str) -> None:
    bases = [data.systems[system].base_engine for system in panel]
    if len(bases) != len(set(bases)):
        raise RuntimeError(f"duplicate base engine in {data.source_id} {label}: {bases}")


def selected_panel_names(data: MatrixData, panel: list[str]) -> list[str]:
    return [data.systems[system].display_name for system in panel]


def sensitivity_summary(
    data: MatrixData, candidates: list[str], k: int, train_tasks: list[str], primary: list[str]
) -> str:
    parts = []
    primary_set = set(primary)
    for capture in CAPTURE_SENSITIVITY:
        panel, _ = exhaustive_select_v(data, candidates, k, train_tasks, capture)
        changed = set(panel) != primary_set
        label = "changed" if changed else "same"
        parts.append(
            f"capture={capture:.1f}: {label} ({'; '.join(selected_panel_names(data, panel))})"
        )
    return "; ".join(parts)


def analyze_data(data: MatrixData) -> list[dict[str, Any]]:
    candidates = sorted(data.y)
    common_all = common_tasks(data.y, candidates)
    train_clusters, heldout_clusters = split_clusters(data, common_all)
    if train_clusters & heldout_clusters:
        raise RuntimeError(f"cluster leakage in {data.source_id}")
    train_tasks = tasks_for_clusters(data, train_clusters)
    heldout_tasks = tasks_for_clusters(data, heldout_clusters)
    rows = []
    for k in (2, 3):
        if len(candidates) < k:
            continue
        v_panel, train_v = exhaustive_select_v(data, candidates, k, train_tasks, CAPTURE_PRIMARY)
        baseline_panel = topk_by_average(data, candidates, k, train_tasks)
        if len(v_panel) != k or len(baseline_panel) != k:
            continue
        assert_unique_base(data, v_panel, f"K={k} V-selected")
        assert_unique_base(data, baseline_panel, f"K={k} baseline")
        heldout_common = [
            task
            for task in heldout_tasks
            if all(task in data.y[system] for system in set(v_panel + baseline_panel))
        ]
        delta_v = panel_value(data, v_panel, heldout_common, CAPTURE_PRIMARY) - panel_value(
            data, baseline_panel, heldout_common, CAPTURE_PRIMARY
        )
        delta_oracle = oracle_on_tasks(data.y, v_panel, heldout_common) - oracle_on_tasks(
            data.y, baseline_panel, heldout_common
        )
        delta_best_single = best_pass_on_tasks(data, v_panel, heldout_common) - best_pass_on_tasks(
            data, baseline_panel, heldout_common
        )
        ci_low, ci_high = clustered_ci(
            heldout_common,
            data.clusters,
            lambda sampled, v=v_panel, b=baseline_panel: (
                panel_value(data, v, sampled, CAPTURE_PRIMARY)
                - panel_value(data, b, sampled, CAPTURE_PRIMARY)
            ),
            n_boot=BOOTSTRAPS,
            seed=SEED,
        )
        identical = set(v_panel) == set(baseline_panel)
        status = (
            "selection agrees with baseline"
            if identical
            else "pass"
            if ci_low > 0
            else "fail"
            if ci_high < 0
            else "inconclusive"
        )
        rows.append(
            {
                "source_id": data.source_id,
                "source_title": data.title,
                "k": k,
                "train_clusters": len(train_clusters),
                "heldout_clusters": len(heldout_clusters),
                "heldout_tasks": len(heldout_common),
                "v_panel": v_panel,
                "v_panel_names": selected_panel_names(data, v_panel),
                "baseline_panel": baseline_panel,
                "baseline_panel_names": selected_panel_names(data, baseline_panel),
                "panels_identical": identical,
                "train_v": train_v,
                "heldout_delta_v": delta_v,
                "heldout_delta_v_ci_low": ci_low,
                "heldout_delta_v_ci_high": ci_high,
                "heldout_delta_oracle": delta_oracle,
                "heldout_delta_best_single": delta_best_single,
                "capture_sensitivity": sensitivity_summary(
                    data, candidates, k, train_tasks, v_panel
                ),
                "status": status,
                "split_leakage": bool(train_clusters & heldout_clusters),
            }
        )
    return rows


def flatten_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat = []
    for row in rows:
        flat.append(
            {
                "source_id": row["source_id"],
                "k": row["k"],
                "train_clusters": row["train_clusters"],
                "heldout_clusters": row["heldout_clusters"],
                "heldout_tasks": row["heldout_tasks"],
                "v_panel": " | ".join(row["v_panel_names"]),
                "baseline_panel": " | ".join(row["baseline_panel_names"]),
                "panels_identical": row["panels_identical"],
                "heldout_delta_v": round(row["heldout_delta_v"], 6),
                "heldout_delta_v_ci_low": round(row["heldout_delta_v_ci_low"], 6),
                "heldout_delta_v_ci_high": round(row["heldout_delta_v_ci_high"], 6),
                "heldout_delta_oracle": round(row["heldout_delta_oracle"], 6),
                "heldout_delta_best_single": round(row["heldout_delta_best_single"], 6),
                "capture_sensitivity": row["capture_sensitivity"],
                "status": row["status"],
                "split_leakage": row["split_leakage"],
            }
        )
    return flat


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def verdict(rows: list[dict[str, Any]]) -> str:
    if any(row["heldout_delta_v_ci_low"] > 0 for row in rows):
        return "PASS"
    non_identical = [row for row in rows if not row["panels_identical"]]
    if non_identical and all(row["heldout_delta_v_ci_high"] < 0 for row in non_identical):
        return "FAIL"
    return "INCONCLUSIVE"


def write_report(rows: list[dict[str, Any]]) -> None:
    overall = verdict(rows)
    identical_count = sum(1 for row in rows if row["panels_identical"])

    parts = [
        "# C2V V-selection re-test",
        "",
        "## Overall verdict",
        "",
        f"**{overall}** by the preregistered rule.",
        "",
        "V-selection agreed exactly with the top-K baseline in "
        f"{identical_count}/{len(rows)} source×K cases.",
        "",
        "## Per-source results",
        "",
        md_table(
            [
                "Source",
                "K",
                "V-selected panel",
                "Top-K baseline",
                "Identical",
                "Held-out Delta_V",
                "95% CI",
                "Delta_oracle",
                "Delta_best_single",
                "Status",
            ],
            [
                [
                    row["source_id"],
                    row["k"],
                    "; ".join(row["v_panel_names"]),
                    "; ".join(row["baseline_panel_names"]),
                    "yes" if row["panels_identical"] else "no",
                    fmt_pp(row["heldout_delta_v"]),
                    fmt_ci(row["heldout_delta_v_ci_low"], row["heldout_delta_v_ci_high"]),
                    fmt_pp(row["heldout_delta_oracle"]),
                    fmt_pp(row["heldout_delta_best_single"]),
                    row["status"],
                ]
                for row in rows
            ],
        ),
        "",
        "## Capture sensitivity",
        "",
        md_table(
            ["Source", "K", "Sensitivity result"],
            [[row["source_id"], row["k"], row["capture_sensitivity"]] for row in rows],
        ),
        "",
        "## Interpretation vs original C2",
        "",
    ]
    pass_rows = [row for row in rows if row["heldout_delta_v_ci_low"] > 0]
    negative_rows = [
        row for row in rows if not row["panels_identical"] and row["heldout_delta_v_ci_high"] < 0
    ]
    if pass_rows:
        parts.append(
            "V-selection closes the original oracle-only gap for at least one source×K case: "
            + ", ".join(f"{row['source_id']} K={row['k']}" for row in pass_rows)
            + "."
        )
    else:
        parts.append(
            "V-selection did not produce a statistically positive held-out "
            "Delta_V over the top-K baseline in this run."
        )
    if negative_rows:
        parts.append(
            "Unlike pure oracle selection, V-selection still loses outright in "
            + ", ".join(f"{row['source_id']} K={row['k']}" for row in negative_rows)
            + "."
        )
    else:
        parts.append(
            "The re-test removes the strongest oracle-only failure mode: "
            "no non-identical V-selected panel has a strictly negative "
            "Delta_V CI."
        )
    parts.extend(
        [
            "Identical-panel cases are informative ties: the V objective "
            "prefers the same strong systems as the average-score baseline "
            "rather than weak decorrelated systems.",
            "",
            "## Sanity guards",
            "",
            "- Source system counts matched the original C2 report/preregistration counts.",
            "- No selected V or baseline panel contains duplicate base engines.",
            "- Clustered split leakage was false for every source and K.",
            "- No billed API calls were made.",
            "",
            "## Limitations and deviations",
            "",
            "- The analysis uses the same public Layer-1 rows as original C2; "
            "A- sources remain scaffold-confounded and system-level.",
            "- Terminal-Bench rows are loaded from the public HF parquet "
            "endpoint, as in the working C1/C2 loader.",
            "- The original C2 preregistration's recorded base-engine parser "
            "correction is inherited from the working analysis script.",
            "- No deviations from the C2V preregistered objective, split, "
            "baseline, bootstrap, or pass/fail rule.",
        ]
    )
    REPORT.write_text("\n".join(parts) + "\n")


def main() -> None:
    if not PREREG.exists():
        raise FileNotFoundError(f"{PREREG} must exist before C2V analysis")
    data_sets = build_all_data()
    validate_source_universe(data_sets)
    rows: list[dict[str, Any]] = []
    for data in data_sets:
        rows.extend(analyze_data(data))
    write_csv(RESULTS, flatten_rows(rows))
    write_report(rows)
    print(f"wrote {RESULTS}")
    print(f"wrote {REPORT}")
    print(f"verdict {verdict(rows)}")


if __name__ == "__main__":
    main()
