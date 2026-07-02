"""Phase 6a — shipped-path validation (audit 20260701-2027).

Runs a subset of the LOCKED-window LiveCodeBench tasks through the real
`fusionkit serve` gateway (`/v1/chat/completions`, model `fusionkit/panel`)
with the tuned deep panel config, verifies the fused programs against the full
official test sets, and compares per-task results with the engine-level
locked-test rows. Pass = no significant degradation and zero pipeline errors.

Usage:
  uv run python audit/20260701-2027/phase6/shipped_path_check.py \
      --gateway http://127.0.0.1:8091 --subset 25
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import httpx

from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.livecodebench_data import LCB_PROMPT_SUFFIX, decode_tests, load_problems
from fusionkit_evals.prompt_tuning import mcnemar
from fusionkit_evals.sandbox import SandboxConfig, build_sandbox

ENGINE_ROWS = "audit/20260701-2027/phase6/locked-test-rows-with-stages.json"
OUT = "audit/20260701-2027/phase6/shipped-path-check.json"


async def fuse_via_gateway(
    client: httpx.AsyncClient, gateway: str, prompt: str
) -> tuple[str | None, str | None]:
    try:
        response = await client.post(
            f"{gateway}/v1/chat/completions",
            json={
                "model": "fusionkit/panel",
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=900.0,
        )
    except httpx.HTTPError as exc:
        return None, f"transport: {exc}"
    if response.status_code != 200:
        return None, f"http {response.status_code}: {response.text[:300]}"
    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        return None, f"no choices: {json.dumps(payload)[:300]}"
    content = (choices[0].get("message") or {}).get("content")
    if not isinstance(content, str) or not content.strip():
        return None, "empty content"
    return content, None


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gateway", default="http://127.0.0.1:8091")
    parser.add_argument("--subset", type=int, default=25)
    parser.add_argument("--concurrency", type=int, default=3)
    args = parser.parse_args()

    engine_rows = json.loads(Path(ENGINE_ROWS).read_text())
    problems = {str(p["question_id"]): p for p in load_problems(10000)}
    # Deterministic subset: first N locked-window task ids in sorted order.
    task_ids = sorted(engine_rows)[: args.subset]

    sandbox = build_sandbox(SandboxConfig(backend="local"))
    semaphore = asyncio.Semaphore(args.concurrency)
    results: dict[str, dict] = {}

    async with httpx.AsyncClient() as client:

        async def run_one(task_id: str) -> None:
            problem = problems[task_id]
            prompt = (problem.get("question_content") or "") + LCB_PROMPT_SUFFIX
            async with semaphore:
                content, error = await fuse_via_gateway(client, args.gateway, prompt)
            if error is not None:
                results[task_id] = {"outcome": "pipeline_error", "error": error}
                print(f"  {task_id}: PIPELINE ERROR {error}", flush=True)
                return
            assert content is not None
            code = extract_code(content).code
            tests = decode_tests(problem, 0)
            run = await asyncio.to_thread(
                verify_solution, sandbox, code, tests, timeout_s=8.0, checker_mode="exact"
            )
            engine_passed = bool(engine_rows[task_id].get("passed"))
            results[task_id] = {
                "outcome": "scored",
                "gateway_passed": run.passed,
                "engine_passed": engine_passed,
            }
            print(
                f"  {task_id}: gateway={'PASS' if run.passed else 'FAIL'} "
                f"engine={'PASS' if engine_passed else 'FAIL'}",
                flush=True,
            )

        await asyncio.gather(*(run_one(task_id) for task_id in task_ids))

    scored = {tid: r for tid, r in results.items() if r["outcome"] == "scored"}
    errors = {tid: r for tid, r in results.items() if r["outcome"] != "scored"}
    gateway_passes = {tid: r["gateway_passed"] for tid, r in scored.items()}
    engine_passes = {tid: r["engine_passed"] for tid, r in scored.items()}
    comparison = mcnemar(engine_passes, gateway_passes)
    n = len(scored)
    summary = {
        "gateway": args.gateway,
        "n_tasks": len(task_ids),
        "scored": n,
        "pipeline_errors": len(errors),
        "gateway_pass_rate": sum(gateway_passes.values()) / n if n else None,
        "engine_pass_rate_same_tasks": sum(engine_passes.values()) / n if n else None,
        "gateway_vs_engine_mcnemar": {
            "wins": comparison.wins,
            "losses": comparison.losses,
            "statistic": comparison.statistic,
            "significant": comparison.significant,
        },
        "results": results,
    }
    Path(OUT).write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
