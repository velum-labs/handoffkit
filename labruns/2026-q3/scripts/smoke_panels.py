#!/usr/bin/env python3
"""Phase B smoke: verify benchmark-panel YAML configs resolve on OpenRouter.

Checks each endpoint with a trivial chat call, then one fused panel turn.
Exit 0 only if every endpoint and the panel fusion path succeed.

Usage:
  uv run python labruns/2026-q3/scripts/smoke_panels.py configs/benchmark-panel.h1-backbone.yaml
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage


async def smoke_config(path: Path) -> dict[str, object]:
    cfg = load_config(path)
    clients = build_clients(cfg)
    out: dict[str, object] = {
        "config": str(path),
        "panel_models": list(cfg.panel_models or []),
        "judge_model": cfg.judge_model,
        "endpoints": [],
        "panel_fusion": None,
    }
    for ep in cfg.endpoints:
        client = clients[ep.id]
        try:
            resp = await client.chat(
                [ChatMessage(role="user", content="Reply with exactly: OK")],
                cfg.sampling,
            )
            out["endpoints"].append(
                {
                    "id": ep.id,
                    "model": ep.model,
                    "status": "ok",
                    "preview": (resp.content or "")[:120],
                }
            )
        except Exception as exc:  # noqa: BLE001 — smoke surfaces provider errors verbatim
            out["endpoints"].append(
                {"id": ep.id, "model": ep.model, "status": "fail", "error": str(exc)}
            )
    engine = FusionEngine(config=cfg, clients=clients)
    try:
        result = await engine.run(
            [ChatMessage(role="user", content="Write a one-line Python print('hello').")],
            mode="panel",
        )
        out["panel_fusion"] = {
            "status": "ok",
            "trajectory_count": len(result.trajectories),
            "preview": (result.content or "")[:200],
        }
    except Exception as exc:  # noqa: BLE001
        out["panel_fusion"] = {"status": "fail", "error": str(exc)}
    for client in clients.values():
        await client.aclose()
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-test benchmark-panel YAML configs")
    parser.add_argument("configs", nargs="+", type=Path)
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is required", file=sys.stderr)
        raise SystemExit(2)

    results = [asyncio.run(smoke_config(path)) for path in args.configs]
    print(json.dumps(results, indent=2))
    ok = all(
        ep["status"] == "ok"
        for row in results
        for ep in row["endpoints"]  # type: ignore[index]
    ) and all(row.get("panel_fusion", {}).get("status") == "ok" for row in results)
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
