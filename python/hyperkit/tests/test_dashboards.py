from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TELEMETRY = ROOT / "python" / "hyperkit" / "src" / "hyperkit" / "telemetry.py"
VALIDATOR = ROOT / "scripts" / "validate_hyperkit_dashboards.py"
DASHBOARDS = ROOT / "infra" / "hyperkit" / "grafana" / "dashboards"
METRIC_PATTERN = re.compile(r"\b(?:hyperkit|otelcol)_[A-Za-z0-9_]+\b(?=\s*(?:\{|\[))")
HYPERGRID_METRICS = {
    "hyperkit_cell_completed_shards",
    "hyperkit_cell_cost_per_resolve",
    "hyperkit_cell_cost_usd",
    "hyperkit_cell_delta_vs_best_single",
    "hyperkit_cell_errors",
    "hyperkit_cell_latency_p50_seconds",
    "hyperkit_cell_latency_p95_seconds",
    "hyperkit_cell_pareto",
    "hyperkit_cell_planned_shards",
    "hyperkit_cell_rank",
    "hyperkit_cell_resolution_rate",
    "hyperkit_cell_resolved_shards",
    "hyperkit_cell_wilson_high",
    "hyperkit_cell_wilson_low",
    "hyperkit_cells_total",
    "hyperkit_shards_pending",
    "hyperkit_shards_running",
}


def test_dashboards_only_query_supported_metrics() -> None:
    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--static-only"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "validated 91 dashboard queries across 9 dashboards" in result.stdout


def test_hyperkit_dashboard_metrics_match_otel_translation() -> None:
    source = TELEMETRY.read_text(encoding="utf-8")
    instruments = set(re.findall(r'create_(?:counter|histogram)\("([^"]+)"', source))
    translated = set()
    for name in instruments:
        call = _instrument_call(source, name)
        metric = name.replace(".", "_")
        if "create_histogram" in call:
            metric += "_seconds_bucket"
        else:
            metric += "_total"
        translated.add(metric)

    dashboard_metrics = {
        metric
        for path in DASHBOARDS.glob("*.json")
        for panel in json.loads(path.read_text(encoding="utf-8"))["panels"]
        for target in panel["targets"]
        for metric in METRIC_PATTERN.findall(target["expr"])
        if metric.startswith("hyperkit_")
    }

    assert dashboard_metrics == translated | HYPERGRID_METRICS


def _instrument_call(source: str, name: str) -> str:
    match = re.search(rf'create_(?:counter|histogram)\("{re.escape(name)}"[^)]*\)', source)
    assert match is not None
    return match.group(0)
