#!/usr/bin/env python3
"""Phase B gateway smoke: exercise the full Node fusionkit-dev serve path.

For each benchmark-panel YAML:
  1. Spawns `node scripts/fusionkit-dev.mjs serve` with matching --model flags
  2. Waits for the gateway /health endpoint
  3. POSTs one fused `fusion-panel` chat completion
  4. Verifies HTTP 200 and judge synthesis with expected trajectory count

Requires OPENROUTER_API_KEY and a built CLI (`pnpm build:cli`).

Usage:
  uv run python labruns/2026-q3/scripts/smoke_gateway.py \\
    configs/benchmark-panel.h1-backbone.yaml
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fusionkit_core.config import load_config


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "scripts" / "fusionkit-dev.mjs").is_file():
            return parent
    raise RuntimeError("could not locate repo root (scripts/fusionkit-dev.mjs)")


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_http(url: str, *, timeout_s: float = 120.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if 200 <= resp.status < 300:
                    return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.5)
    raise TimeoutError(f"timed out waiting for {url}")


def post_chat(url: str, body: dict[str, object], *, timeout_s: float = 300.0) -> dict[str, object]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def serve_argv(cfg_path: Path, *, port: int, repo: Path) -> list[str]:
    cfg = load_config(cfg_path)
    panel_ids = list(cfg.panel_models or [])
    endpoints = {ep.id: ep for ep in cfg.endpoints}
    models: list[str] = []
    for ep_id in panel_ids:
        ep = endpoints[ep_id]
        models.append(f"--model")
        models.append(f"{ep.id}=openrouter:{ep.model}")
    judge = cfg.judge_model or panel_ids[0]
    return [
        "node",
        str(repo / "scripts" / "fusionkit-dev.mjs"),
        "serve",
        "--yes",
        "--no-observe",
        "--no-portless",
        f"--port={port}",
        f"--repo={repo}",
        *models,
        f"--judge-model={judge}",
    ]


def smoke_config(cfg_path: Path, *, repo: Path) -> dict[str, object]:
    cfg = load_config(cfg_path)
    panel_ids = list(cfg.panel_models or [])
    port = pick_port()
    env = os.environ.copy()
    env.setdefault("FUSIONKIT_DEV_SKIP_BUILD", "1")
    env.setdefault("FUSIONKIT_DIR", str(repo))
    proc = subprocess.Popen(
        serve_argv(cfg_path, port=port, repo=repo),
        cwd=repo,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    out: dict[str, object] = {
        "config": str(cfg_path),
        "panel_models": panel_ids,
        "judge_model": cfg.judge_model,
        "gateway_port": port,
        "gateway_fusion": None,
    }
    try:
        wait_http(f"http://127.0.0.1:{port}/health", timeout_s=120.0)
        body = post_chat(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            {
                "model": "fusion-panel",
                "messages": [
                    {
                        "role": "user",
                        "content": "Write a one-line Python print('hello').",
                    }
                ],
            },
            timeout_s=300.0,
        )
        fusion = body.get("fusion", {})
        trajectory = fusion.get("trajectory", {}) if isinstance(fusion, dict) else {}
        synthesis = trajectory.get("synthesis", {}) if isinstance(trajectory, dict) else {}
        input_ids = synthesis.get("input_trajectory_ids", []) if isinstance(synthesis, dict) else []
        choices = body.get("choices", [])
        content = ""
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
            content = str(msg.get("content", "")) if isinstance(msg, dict) else ""
        out["gateway_fusion"] = {
            "status": "ok",
            "trajectory_count": len(input_ids),
            "preview": content[:200],
            "model_ids": [
                row.get("model_id")
                for row in synthesis.get("metrics", {}).get("trajectory_contributions", [])
                if isinstance(row, dict)
            ]
            if isinstance(synthesis, dict)
            else [],
        }
    except Exception as exc:  # noqa: BLE001 — smoke surfaces gateway errors verbatim
        out["gateway_fusion"] = {"status": "fail", "error": str(exc)}
        if proc.stdout is not None:
            tail = proc.stdout.read()[-4000:]
            out["serve_log_tail"] = tail
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test benchmark panels via fusionkit-dev gateway")
    parser.add_argument("configs", nargs="+", type=Path)
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is required", file=sys.stderr)
        raise SystemExit(2)

    root = repo_root()
    results = [smoke_config(path, repo=root) for path in args.configs]
    print(json.dumps(results, indent=2))
    ok = all(row.get("gateway_fusion", {}).get("status") == "ok" for row in results)
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
