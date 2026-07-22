"""Runner for the D10 seed-panel truncation audit.

Registers the three seed-panel OpenRouter endpoints in the committed phase0
C3 module, then delegates to the committed thinking-32k runner logic
(bank/outcome/ledger handling, budget guard, incremental persistence).
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

ROOT = Path("/workspace")
THINKING_RUNNER = ROOT / "analysis" / "thinking-32k" / "scripts" / "c3_thinking32k_runner.py"

SPEC = importlib.util.spec_from_file_location("c3_thinking32k_runner", THINKING_RUNNER)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)
c3 = runner.c3

SEED_SPECS = {
    "r1": c3.EndpointSpec(
        "r1",
        "openrouter",
        "deepseek/deepseek-r1-0528",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.50,
        2.15,
    ),
    "terminus": c3.EndpointSpec(
        "terminus",
        "openrouter",
        "deepseek/deepseek-v3.1-terminus",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.27,
        0.95,
    ),
    "qwen3t": c3.EndpointSpec(
        "qwen3t",
        "openrouter",
        "qwen/qwen3-235b-a22b-thinking-2507",
        "https://openrouter.ai/api",
        "OPENROUTER_API_KEY",
        0.1495,
        1.495,
    ),
}


def main() -> int:
    c3.MODEL_SPECS.update(SEED_SPECS)
    args = runner.parser().parse_args()
    if args.command == "build-bank":
        return asyncio.run(runner.build_bank(args))
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
