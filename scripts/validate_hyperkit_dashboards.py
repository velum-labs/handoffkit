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
    "hyperkit-fleet",
    "hyperkit-fusion-internal",
    "hyperkit-sweep-live",
}
SUPPORTED_METRICS = {
    "hyperkit_cost_usd_total",
    "hyperkit_shard_latency_seconds_bucket",
    "hyperkit_shards_completed_total",
    "hyperkit_shards_errors_total",
    "hyperkit_shards_resolved_total",
    "otelcol_exporter_send_failed_metric_points",
    "otelcol_exporter_sent_metric_points",
    "otelcol_receiver_accepted_metric_points",
    "otelcol_receiver_refused_metric_points",
}
METRIC_PATTERN = re.compile(r"\b(?:hyperkit|otelcol)_[A-Za-z0-9_]+\b(?=\s*(?:\{|\[))")
SUBSTITUTIONS = {
    "$__rate_interval": "5s",
    "$__range": "5m",
    "$benchmark": ".*",
    "$run_id": ".*",
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
        for panel in dashboard.get("panels", []):
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

    queries = iter_panel_queries(dashboards)
    referenced = {
        metric for _, _, expression in queries for metric in METRIC_PATTERN.findall(expression)
    }
    unsupported = referenced - SUPPORTED_METRICS
    if unsupported:
        raise ValueError(f"dashboard queries reference unsupported metrics: {sorted(unsupported)}")
    if "vector(0)" in " ".join(expression for _, _, expression in queries):
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
    values = frame.get("data", {}).get("values", [])
    return any(
        value is not None
        for field_values in values
        if isinstance(field_values, list)
        for value in field_values
    )


def execute_queries(
    client: GrafanaClient,
    queries: list[tuple[str, str, str]],
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
        if not frames or not any(_frame_has_data(frame) for frame in frames):
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
    return iter_panel_queries(dashboards)


def validate_live(
    client: GrafanaClient,
    attempts: int,
    retry_interval: float,
) -> None:
    last_failures: list[str] = []
    for _ in range(attempts):
        health_status, health = client.request("/api/datasources/uid/amp/health")
        if health_status == 200 and health.get("status") in {"OK", "Success"}:
            live_queries = load_live_queries(client)
            last_failures = execute_queries(client, live_queries)
            if not last_failures:
                return
        else:
            last_failures = [
                f"Prometheus datasource unhealthy (HTTP {health_status}): {health.get('message')}"
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
    args = parser.parse_args()

    try:
        queries = validate_static_contracts()
        if not args.static_only:
            client = GrafanaClient(args.grafana_url, args.username, args.password)
            validate_live(client, args.attempts, args.retry_interval)
    except (OSError, RuntimeError, ValueError, urllib.error.URLError) as exc:
        print(f"dashboard validation failed: {exc}", file=sys.stderr)
        return 1

    mode = "static contracts" if args.static_only else "static contracts and live queries"
    print(
        f"validated {len(queries)} panel queries across "
        f"{len(EXPECTED_DASHBOARDS)} dashboards ({mode})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
