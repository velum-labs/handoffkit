"""One tiny call per seed-audit endpoint to verify provider connectivity."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path("/workspace")
ROUND = ROOT / "analysis" / "seed-audit-32k"

SPEC = importlib.util.spec_from_file_location(
    "seed_audit_runner", ROUND / "scripts" / "seed_audit_runner.py"
)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)
c3 = mod.c3


async def run() -> int:
    c3.MODEL_SPECS.update(mod.SEED_SPECS)
    specs = c3.model_specs(["r1", "terminus", "qwen3t"])
    config = c3.fusion_config(specs, max_tokens=16, request_timeout_s=120.0)
    clients = c3.build_clients(config)
    endpoints = c3.endpoint_by_id(config)
    failures = 0
    rows = []
    for model_id in config.panel_models:
        endpoint = endpoints[model_id]
        try:
            response = await clients[model_id].chat(
                [c3.ChatMessage(role="user", content="Reply with exactly: OK")],
                c3.SamplingConfig(temperature=0.0, top_p=1.0, max_tokens=16),
            )
            cost = c3.cost_record(endpoint, response=response)
            rows.append({"endpoint_id": model_id, "status": "succeeded", **cost})
        except Exception as exc:
            failures += 1
            rows.append(
                {
                    "endpoint_id": model_id,
                    "model": endpoint.model,
                    "status": "failed",
                    "error_message": str(exc)[:500],
                }
            )
    ledger = ROUND / "spend_ledger.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps({"phase": "provider_smoke", **row}, sort_keys=True) + "\n")
    for row in rows:
        print(json.dumps(row, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
