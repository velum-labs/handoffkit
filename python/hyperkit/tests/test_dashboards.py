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
GRAFANA_DOCKERFILE = ROOT / "infra" / "hyperkit" / "grafana" / "Dockerfile"
SEED_RULES = ROOT / "infra" / "hyperkit" / "grafana" / "local" / "seed-rules.yml"
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
    assert "validated 115 dashboard queries across 10 dashboards" in result.stdout


def test_hypergrid_dynamics_business_charts_contract() -> None:
    dashboard = json.loads(
        (DASHBOARDS / "hypergrid-dynamics.json").read_text(encoding="utf-8")
    )
    panels = dashboard["panels"]

    assert dashboard["uid"] == "hyperkit-hypergrid-dynamics"
    assert dashboard["refresh"] == "5s"
    assert {variable["name"] for variable in dashboard["templating"]["list"]} == {
        "benchmark",
        "generation",
        "run_id",
    }
    assert len(panels) == 6
    assert {panel["type"] for panel in panels} == {"volkovlabs-echarts-panel"}
    assert {panel["pluginVersion"] for panel in panels} == {"7.2.5"}

    code = "\n".join(panel["options"]["getOption"] for panel in panels)
    for chart_type in ("scatter", "parallel", "heatmap", "sankey", "bar", "custom"):
        assert f"type: '{chart_type}'" in code
    for feature in (
        "context.panel.data",
        "dataZoom",
        "toolbox",
        "visualMap",
        "animationDurationUpdate",
        "renderItem",
    ):
        assert feature in code
    assert re.search(
        r"\b(?:eval|fetch|XMLHttpRequest|WebSocket|axios)\s*\(|https?://",
        code,
        re.IGNORECASE,
    ) is None


def test_business_charts_plugin_is_pinned() -> None:
    dockerfile = GRAFANA_DOCKERFILE.read_text(encoding="utf-8")

    assert "ARG BUSINESS_CHARTS_PLUGIN_VERSION=7.2.5" in dockerfile
    assert (
        "plugins install volkovlabs-echarts-panel "
        '"${BUSINESS_CHARTS_PLUGIN_VERSION}"'
    ) in dockerfile


def test_local_seed_has_rich_dynamic_hypergrid() -> None:
    seed = SEED_RULES.read_text(encoding="utf-8")

    assert len(set(re.findall(r'cell_id: "([^"]+)"', seed))) >= 9
    assert len(set(re.findall(r'generation: "([^"]+)"', seed))) >= 3
    assert len(set(re.findall(r'topology: "([^"]+)"', seed))) >= 3
    assert seed.count("sin(vector(time()") >= 20


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
