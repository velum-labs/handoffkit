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


def test_dashboards_only_query_supported_metrics() -> None:
    result = subprocess.run(
        [sys.executable, str(VALIDATOR), "--static-only"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "validated 20 panel queries" in result.stdout


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

    assert dashboard_metrics == translated


def _instrument_call(source: str, name: str) -> str:
    match = re.search(rf'create_(?:counter|histogram)\("{re.escape(name)}"[^)]*\)', source)
    assert match is not None
    return match.group(0)
