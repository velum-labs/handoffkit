#!/usr/bin/env python3
"""Validate Hyperkit dashboard contracts and execute every panel query."""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = ROOT / "infra" / "hyperkit" / "grafana" / "dashboards"
EXPECTED_DASHBOARDS = {
    "hyperkit-cell-drilldown",
    "hyperkit-fleet",
    "hyperkit-fusion-internal",
    "hyperkit-generation-coverage",
    "hyperkit-hypergrid-dynamics",
    "hyperkit-hypergrid-explorer",
    "hyperkit-hypergrid-leaderboard",
    "hyperkit-learning-curve",
    "hyperkit-pareto",
    "hyperkit-sweep-live",
}
REQUIRED_VARIABLES = {
    "hyperkit-cell-drilldown": {"benchmark", "cell_id", "generation", "run_id"},
    "hyperkit-generation-coverage": {"benchmark", "run_id"},
    "hyperkit-hypergrid-dynamics": {"benchmark", "generation", "run_id"},
    "hyperkit-hypergrid-explorer": {
        "benchmark",
        "generation",
        "run_id",
        "x_dimension",
        "y_dimension",
    },
    "hyperkit-hypergrid-leaderboard": {"benchmark", "generation", "run_id"},
    "hyperkit-learning-curve": {"benchmark", "cell_id", "generation", "run_id"},
    "hyperkit-pareto": {"benchmark", "generation", "run_id"},
}
BUSINESS_CHARTS_PLUGIN_ID = "volkovlabs-echarts-panel"
BUSINESS_CHARTS_PLUGIN_VERSION = "7.2.5"
SUPPORTED_PANEL_TYPES = {
    "bargauge",
    "stat",
    "table",
    "timeseries",
    BUSINESS_CHARTS_PLUGIN_ID,
}
EXPECTED_BUSINESS_CHARTS = {
    "Quality / Cost Bubble Explorer": ("type: 'scatter'", "dataZoom", "toolbox"),
    "Model Trade-space Parallel Coordinates": ("type: 'parallel'", "parallelAxis"),
    "Model Resolution Heatmap": ("type: 'heatmap'", "visualMap"),
    "Generation → Role → Model Flow": ("type: 'sankey'", "links"),
    "Live Model Ranking": ("type: 'bar'", "animationDurationUpdate"),
    "Model Resolution Confidence": ("type: 'custom'", "renderItem"),
}
UNSAFE_CHART_CODE_PATTERN = re.compile(
    r"\b(?:eval|fetch|XMLHttpRequest|WebSocket|axios)\s*\(|https?://",
    re.IGNORECASE,
)
SUPPORTED_METRICS = {
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
    "hyperkit_cost_usd_total",
    "hyperkit_shard_latency_seconds_bucket",
    "hyperkit_shards_completed_total",
    "hyperkit_shards_errors_total",
    "hyperkit_shards_pending",
    "hyperkit_shards_resolved_total",
    "hyperkit_shards_running",
    "otelcol_exporter_send_failed_metric_points",
    "otelcol_exporter_sent_metric_points",
    "otelcol_receiver_accepted_metric_points",
    "otelcol_receiver_refused_metric_points",
}
METRIC_PATTERN = re.compile(r"\b(?:hyperkit|otelcol)_[A-Za-z0-9_]+\b(?=\s*(?:\{|\[))")
LABEL_VALUES_PATTERN = re.compile(
    r"^label_values\((?P<selector>.+),\s*(?P<label>[A-Za-z_][A-Za-z0-9_]*)\)$"
)
MASKED_ZERO_PATTERN = re.compile(r"\bvector\s*\(\s*0(?:\.0*)?\s*\)", re.IGNORECASE)
SUBSTITUTIONS = {
    "$__rate_interval": "5s",
    "$__interval": "5s",
    "$__range": "5m",
    "$benchmark": ".*",
    "$cell_id": ".*",
    "$generation": ".*",
    "$run_id": ".*",
    "$x_dimension": "k",
    "$y_dimension": "topology",
}


def load_dashboard_files() -> list[dict[str, Any]]:
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(DASHBOARD_DIR.glob("*.json"))
    ]


def iter_panel_queries(
    dashboards: list[dict[str, Any]],
) -> list[tuple[str, str, str]]:
    queries: list[tuple[str, str, str]] = []
    for dashboard in dashboards:
        panels = list(dashboard.get("panels", []))
        while panels:
            panel = panels.pop(0)
            panels[0:0] = panel.get("panels", [])
            if panel.get("type") == "row" and not panel.get("targets"):
                continue
            if panel.get("type") not in SUPPORTED_PANEL_TYPES:
                raise ValueError(
                    f"{dashboard['uid']} / {panel['title']}: "
                    f"unsupported panel type {panel.get('type')!r}"
                )
            datasource = panel.get("datasource", {})
            if datasource.get("type") != "prometheus" or datasource.get("uid") != "amp":
                raise ValueError(
                    f"{dashboard['uid']} / {panel['title']}: expected Prometheus datasource uid amp"
                )
            targets = panel.get("targets", [])
            if not targets:
                raise ValueError(f"{dashboard['uid']} / {panel['title']}: panel has no targets")
            for target in targets:
                expression = target.get("expr")
                if not expression:
                    raise ValueError(
                        f"{dashboard['uid']} / {panel['title']}: target has no PromQL expression"
                    )
                queries.append((dashboard["uid"], panel["title"], expression))
    return queries


def validate_business_charts(dashboards: list[dict[str, Any]]) -> None:
    dynamics = next(
        (
            dashboard
            for dashboard in dashboards
            if dashboard.get("uid") == "hyperkit-hypergrid-dynamics"
        ),
        None,
    )
    if dynamics is None:
        raise ValueError("Hypergrid Dynamics dashboard is missing")

    charts = {
        panel.get("title"): panel
        for panel in dynamics.get("panels", [])
        if panel.get("type") == BUSINESS_CHARTS_PLUGIN_ID
    }
    if set(charts) != set(EXPECTED_BUSINESS_CHARTS):
        raise ValueError(
            "Hypergrid Dynamics chart set mismatch: "
            f"expected {sorted(EXPECTED_BUSINESS_CHARTS)}, found {sorted(charts)}"
        )

    for title, features in EXPECTED_BUSINESS_CHARTS.items():
        panel = charts[title]
        options = panel.get("options")
        if not isinstance(options, dict):
            raise ValueError(f"{dynamics['uid']} / {title}: missing panel options")
        code = options.get("getOption")
        if not isinstance(code, str) or not code.strip():
            raise ValueError(f"{dynamics['uid']} / {title}: getOption is empty")
        if "context.panel.data" not in code:
            raise ValueError(
                f"{dynamics['uid']} / {title}: getOption must read context.panel.data"
            )
        if match := UNSAFE_CHART_CODE_PATTERN.search(code):
            raise ValueError(
                f"{dynamics['uid']} / {title}: unsafe chart code {match.group()!r}"
            )
        if missing := [feature for feature in features if feature not in code]:
            raise ValueError(
                f"{dynamics['uid']} / {title}: missing chart features {missing}"
            )
        if options.get("editorMode") != "code":
            raise ValueError(
                f"{dynamics['uid']} / {title}: expected Business Charts code editor"
            )
        if panel.get("pluginVersion") != BUSINESS_CHARTS_PLUGIN_VERSION:
            raise ValueError(
                f"{dynamics['uid']} / {title}: expected plugin version "
                f"{BUSINESS_CHARTS_PLUGIN_VERSION}"
            )


def iter_variable_queries(
    dashboards: list[dict[str, Any]],
) -> list[tuple[str, str, str]]:
    queries: list[tuple[str, str, str]] = []
    for dashboard in dashboards:
        variables = dashboard.get("templating", {}).get("list", [])
        names = {
            variable.get("name")
            for variable in variables
            if isinstance(variable.get("name"), str)
        }
        required = REQUIRED_VARIABLES.get(dashboard["uid"], set())
        if missing := required - names:
            raise ValueError(
                f"{dashboard['uid']}: missing required variables {sorted(missing)}"
            )

        for variable in variables:
            variable_type = variable.get("type")
            name = variable.get("name", "<unnamed>")
            if variable_type == "query":
                datasource = variable.get("datasource", {})
                if datasource.get("type") != "prometheus" or datasource.get("uid") != "amp":
                    raise ValueError(
                        f"{dashboard['uid']} / variable {name}: "
                        "expected Prometheus datasource uid amp"
                    )
                raw_query = variable.get("query", "")
                query = (
                    raw_query.get("query", "")
                    if isinstance(raw_query, dict)
                    else raw_query
                )
                match = LABEL_VALUES_PATTERN.fullmatch(query.strip())
                if match is None:
                    raise ValueError(
                        f"{dashboard['uid']} / variable {name}: "
                        "expected label_values(selector, label)"
                    )
                selector = match.group("selector").strip()
                label = match.group("label")
                if re.fullmatch(r"(?:hyperkit|otelcol)_[A-Za-z0-9_]+", selector):
                    selector += "{}"
                queries.append(
                    (
                        dashboard["uid"],
                        f"variable {name}",
                        f"count by ({label}) ({selector})",
                    )
                )
            elif variable_type == "custom":
                if not variable.get("query"):
                    raise ValueError(
                        f"{dashboard['uid']} / variable {name}: custom variable is empty"
                    )
            elif variable_type != "textbox":
                raise ValueError(
                    f"{dashboard['uid']} / variable {name}: "
                    f"unsupported variable type {variable_type!r}"
                )
    return queries


def validate_static_contracts() -> list[tuple[str, str, str]]:
    dashboards = load_dashboard_files()
    actual_uids: set[str] = {
        uid
        for dashboard in dashboards
        if isinstance((uid := dashboard.get("uid")), str)
    }
    if actual_uids != EXPECTED_DASHBOARDS:
        raise ValueError(
            f"dashboard set mismatch: expected {sorted(EXPECTED_DASHBOARDS)}, "
            f"found {sorted(actual_uids)}"
        )

    validate_business_charts(dashboards)
    queries = iter_panel_queries(dashboards) + iter_variable_queries(dashboards)
    referenced = {
        metric for _, _, expression in queries for metric in METRIC_PATTERN.findall(expression)
    }
    unsupported = referenced - SUPPORTED_METRICS
    if unsupported:
        raise ValueError(f"dashboard queries reference unsupported metrics: {sorted(unsupported)}")
    if MASKED_ZERO_PATTERN.search(" ".join(expression for _, _, expression in queries)):
        raise ValueError("dashboard query masks missing telemetry with vector(0)")
    return queries


class GrafanaClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        }

    def request(
        self, path: str, payload: dict[str, Any] | None = None
    ) -> tuple[int, Any]:
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=self.headers,
            method="POST" if body is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw)
            except json.JSONDecodeError:
                return exc.code, {"message": raw[:500]}


def _substitute(expression: str) -> str:
    for variable, value in SUBSTITUTIONS.items():
        expression = expression.replace(variable, value)
    return expression


def _frame_has_data(frame: dict[str, Any]) -> bool:
    fields = frame.get("schema", {}).get("fields", [])
    values = frame.get("data", {}).get("values", [])
    return any(
        value is not None
        for index, field_values in enumerate(values)
        if index >= len(fields) or fields[index].get("type") != "time"
        if isinstance(field_values, list)
        for value in field_values
    )


def execute_queries(
    client: GrafanaClient,
    queries: list[tuple[str, str, str]],
    *,
    require_data: bool,
) -> list[str]:
    now_ms = int(time.time() * 1000)
    request_queries = []
    labels: dict[str, str] = {}
    for index, (dashboard_uid, panel_title, expression) in enumerate(queries):
        ref_id = f"Q{index}"
        labels[ref_id] = f"{dashboard_uid} / {panel_title}"
        request_queries.append(
            {
                "datasource": {"type": "prometheus", "uid": "amp"},
                "expr": _substitute(expression),
                "format": "time_series",
                "intervalMs": 1_000,
                "maxDataPoints": 300,
                "range": True,
                "refId": ref_id,
            }
        )

    status, response = client.request(
        "/api/ds/query",
        {
            "from": str(now_ms - 300_000),
            "to": str(now_ms),
            "queries": request_queries,
        },
    )
    if status != 200:
        return [f"Grafana query endpoint returned HTTP {status}: {response.get('message')}"]

    failures = []
    results = response.get("results", {})
    for ref_id, label in labels.items():
        result = results.get(ref_id, {})
        if result.get("error") or result.get("status", 200) != 200:
            failures.append(f"{label}: {result.get('error', 'query failed')}")
            continue
        frames = result.get("frames", [])
        if require_data and (
            not frames or not any(_frame_has_data(frame) for frame in frames)
        ):
            failures.append(f"{label}: query returned no seeded data")
    return failures


def load_live_queries(client: GrafanaClient) -> list[tuple[str, str, str]]:
    status, search = client.request("/api/search?tag=hyperkit&type=dash-db")
    if status != 200:
        raise RuntimeError(f"Grafana dashboard search returned HTTP {status}")
    live_uids: set[str] = {
        uid for item in search if isinstance((uid := item.get("uid")), str)
    }
    if live_uids != EXPECTED_DASHBOARDS:
        raise RuntimeError(
            f"provisioned dashboard set mismatch: expected {sorted(EXPECTED_DASHBOARDS)}, "
            f"found {sorted(live_uids)}"
        )

    dashboards = []
    for uid in sorted(EXPECTED_DASHBOARDS):
        status, response = client.request(f"/api/dashboards/uid/{uid}")
        if status != 200:
            raise RuntimeError(f"failed to load provisioned dashboard {uid}: HTTP {status}")
        dashboards.append(response["dashboard"])
    validate_business_charts(dashboards)
    return iter_panel_queries(dashboards) + iter_variable_queries(dashboards)


def validate_live(
    client: GrafanaClient,
    attempts: int,
    retry_interval: float,
    *,
    require_data: bool,
) -> None:
    last_failures: list[str] = []
    for _ in range(attempts):
        plugin_status, plugin = client.request(
            f"/api/plugins/{BUSINESS_CHARTS_PLUGIN_ID}/settings"
        )
        datasource_status, datasource = client.request("/api/datasources/uid/amp")
        health_status, health = client.request("/api/datasources/uid/amp/health")
        datasource_valid = (
            datasource_status == 200
            and datasource.get("uid") == "amp"
            and datasource.get("type") == "prometheus"
        )
        plugin_valid = (
            plugin_status == 200
            and plugin.get("id") == BUSINESS_CHARTS_PLUGIN_ID
            and plugin.get("type") == "panel"
            and bool(plugin.get("module"))
            and plugin.get("signature") == "valid"
            and plugin.get("info", {}).get("version") == BUSINESS_CHARTS_PLUGIN_VERSION
        )
        if (
            plugin_valid
            and
            datasource_valid
            and health_status == 200
            and health.get("status") in {"OK", "Success"}
        ):
            live_queries = load_live_queries(client)
            last_failures = execute_queries(
                client,
                live_queries,
                require_data=require_data,
            )
            if not last_failures:
                return
        else:
            last_failures = [
                "Business Charts plugin or Prometheus datasource invalid/unhealthy "
                f"(plugin HTTP {plugin_status}, version "
                f"{plugin.get('info', {}).get('version')}, signature "
                f"{plugin.get('signature')}; config HTTP {datasource_status}, "
                f"health HTTP {health_status}): "
                f"{health.get('message')}"
            ]
        time.sleep(retry_interval)
    raise RuntimeError("\n".join(last_failures))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grafana-url", default="http://127.0.0.1:13000")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default="validation-only")
    parser.add_argument("--attempts", type=int, default=30)
    parser.add_argument("--retry-interval", type=float, default=1.0)
    parser.add_argument("--static-only", action="store_true")
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="accept valid production queries without recent telemetry",
    )
    args = parser.parse_args()

    try:
        queries = validate_static_contracts()
        if not args.static_only:
            client = GrafanaClient(args.grafana_url, args.username, args.password)
            validate_live(
                client,
                args.attempts,
                args.retry_interval,
                require_data=not args.allow_empty,
            )
    except (OSError, RuntimeError, ValueError, urllib.error.URLError) as exc:
        print(f"dashboard validation failed: {exc}", file=sys.stderr)
        return 1

    mode = "static contracts" if args.static_only else "static contracts and live queries"
    print(
        f"validated {len(queries)} dashboard queries across "
        f"{len(EXPECTED_DASHBOARDS)} dashboards ({mode})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
