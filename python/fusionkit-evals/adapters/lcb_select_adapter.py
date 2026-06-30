"""Execution-guided selection adapter for LiveCodeBench (SOTA code fusion).

For each problem, every panel model produces several samples (temperature
diversity). Each sample is run against the problem's PUBLIC tests; the candidate
passing the most public tests is selected and graded on the held-out PRIVATE tests.
This is the AlphaCode/best-of-N paradigm: selection uses only solver-available
public tests, grading is on private tests (leakage-free), and the fused (selected)
answer beats any single model's pass@1 because the oracle over the diverse pool
exceeds it and public-test filtering reliably captures it.

Emits the standard external-run envelope: per task, ``passed`` is the fused
(selected) private result and ``candidate_scores[model]`` is that model's primary
(first) sample graded on private -- i.e. each model's pass@1 -- so the
compound-vs-individual comparison and McNemar test consume it directly.

Contract: ExternalBenchmarkRequest on stdin, run envelope on stdout. Requires
FUSIONKIT_BENCH_CONFIG (panel YAML) and provider keys. Env: LCB_SELECT_SAMPLES
(default 3), LCB_SELECT_TEMPS (default "0.2,0.6,0.9"), plus the usual LCB_* knobs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.providers import estimate_cost
from fusionkit_core.types import ChatMessage
from fusionkit_evals.bench_runtime import classify_exception, retry_async
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.checkers import CheckerMode
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.exec_select import CandidateSample, select_index
from fusionkit_evals.livecodebench_data import (
    LCB_PROMPT_SUFFIX,
    decode_public_private,
    load_manifest,
    load_problems,
)
from fusionkit_evals.provenance import build_provenance
from fusionkit_evals.sandbox import Sandbox, SandboxConfig, build_sandbox

SCORING_VERSION = "1"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _temps() -> list[float]:
    raw = os.environ.get("LCB_SELECT_TEMPS", "0.2,0.6,0.9")
    return [float(x) for x in raw.split(",") if x.strip()]


def cache_dir() -> Path:
    path = Path(
        os.environ.get(
            "LCB_SELECT_CACHE_DIR",
            str(Path.home() / ".cache" / "fusionkit-bench" / "lcb-select"),
        )
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def signature(engine: FusionEngine, samples: int, temps: list[float]) -> str:
    config = engine.config
    payload = {
        "endpoints": sorted((e.id, e.model, e.provider) for e in config.endpoints),
        "panel_models": sorted(config.panel_models),
        "samples": samples,
        "temps": temps,
        "version": os.environ.get("LCB_VERSION", "release_v6"),
        "scoring_version": SCORING_VERSION,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def cache_path(sig: str, task_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", task_id)
    return cache_dir() / f"{safe}__{sig}.json"


def load_cached(sig: str, task_id: str) -> dict[str, Any] | None:
    path = cache_path(sig, task_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def save_cached(sig: str, row: dict[str, Any]) -> None:
    path = cache_path(sig, row["task_id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(row), encoding="utf-8")
    tmp.replace(path)


def _public_score(
    sandbox: Sandbox, code: str, public: list[dict[str, str]], timeout: float, checker: CheckerMode
) -> tuple[int, int, bool]:
    """(public tests passed before first failure, total public, passed all)."""
    if not public:
        return 0, 0, False
    run = verify_solution(sandbox, code, public, timeout_s=timeout, checker_mode=checker)
    passed = sum(1 for t in run.per_test if t.get("passed"))
    return passed, len(public), run.passed


def _private_pass(
    sandbox: Sandbox, code: str, private: list[dict[str, str]], timeout: float, checker: CheckerMode
) -> bool:
    return verify_solution(sandbox, code, private, timeout_s=timeout, checker_mode=checker).passed


async def evaluate_problem(
    engine: FusionEngine,
    sandbox: Sandbox,
    problem: dict[str, Any],
    *,
    sig: str,
    samples: int,
    temps: list[float],
    timeout: float,
    checker: CheckerMode,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    task_id = str(problem.get("question_id"))
    cached = load_cached(sig, task_id)
    if cached is not None:
        log(f"  {task_id}: cached ({cached.get('outcome')})")
        return cached
    public, private = decode_public_private(problem, 0)
    if not public or not private:
        return _terminal(sig, task_id, "excluded", "missing public/private tests")
    prompt = (problem.get("question_content") or "") + LCB_PROMPT_SUFFIX
    models = list(engine.config.panel_models) or [e.id for e in engine.config.endpoints]

    async with semaphore:
        started = time.monotonic()
        try:
            # Diverse samples per model (temperature/seed varied) for the pool.
            per_model = await retry_async(
                lambda: _generate_all(engine, models, prompt, temps, samples),
                attempts=int(os.environ.get("LCB_RETRIES", "3")),
            )
        except Exception as exc:  # noqa: BLE001
            return _terminal(sig, task_id, classify_exception(exc), str(exc)[:400])
        latency = time.monotonic() - started

    scored = await asyncio.to_thread(
        _score_problem, sandbox, per_model, public, private, timeout, checker
    )
    cost = 0.0
    for model_id, trajs in per_model.items():
        for traj in trajs:
            est = _cost(engine, model_id, traj.metadata.get("usage"))
            if est is not None:
                cost += est
    row = {
        "task_id": task_id,
        "outcome": "scored",
        "passed": scored["fused_private"],
        "score": 1.0 if scored["fused_private"] else 0.0,
        "cost_usd": round(cost, 6),
        "latency_s": round(latency, 2),
        "candidate_scores": scored["candidate_scores"],
        "metadata": {
            "selected_model": scored["selected_model"],
            "oracle_private": scored["oracle_private"],
            "pool_size": scored["pool_size"],
        },
    }
    save_cached(sig, row)
    cs = scored["candidate_scores"]
    flags = " ".join(f"{m}={'P' if v >= 1.0 else 'F'}" for m, v in cs.items())
    log(
        f"  {task_id} fused={'PASS' if scored['fused_private'] else 'FAIL'} "
        f"sel={scored['selected_model']} oracle={'P' if scored['oracle_private'] else 'F'} {flags}"
    )
    return row


async def _generate_all(
    engine: FusionEngine,
    models: list[str],
    prompt: str,
    temps: list[float],
    samples: int,
) -> dict[str, list[Any]]:
    messages = [ChatMessage(role="user", content=prompt)]
    out: dict[str, list[Any]] = {}
    for model_id in models:
        trajs = await engine.producer.generate_self_fusion(
            model_id, messages, engine.config.sampling, temps, samples
        )
        out[model_id] = trajs
    return out


def _score_problem(
    sandbox: Sandbox,
    per_model: dict[str, list[Any]],
    public: list[dict[str, str]],
    private: list[dict[str, str]],
    timeout: float,
    checker: CheckerMode,
) -> dict[str, Any]:
    pool: list[tuple[str, str]] = []  # (model_id, code)
    primaries: dict[str, str] = {}  # model_id -> primary sample code
    for model_id, trajs in per_model.items():
        for index, traj in enumerate(trajs):
            code = extract_code(traj.content).code
            pool.append((model_id, code))
            if index == 0:
                primaries[model_id] = code

    # Selection on public tests (leakage-free).
    samples_pub: list[CandidateSample] = []
    for model_id, code in pool:
        passed, total, _all = _public_score(sandbox, code, public, timeout, checker)
        samples_pub.append(
            CandidateSample(
                model_id=model_id, public_passed=passed, public_total=total, private_pass=False
            )
        )
    sel = select_index(samples_pub)
    selected_model, selected_code = pool[sel]

    fused_private = _private_pass(sandbox, selected_code, private, timeout, checker)
    # Each model's pass@1 = its primary sample graded on private.
    candidate_scores = {
        model_id: (1.0 if _private_pass(sandbox, code, private, timeout, checker) else 0.0)
        for model_id, code in primaries.items()
    }
    # Oracle over the pool (any sample passes private) for headroom reference.
    oracle_private = any(
        _private_pass(sandbox, code, private, timeout, checker) for _, code in pool
    )
    return {
        "fused_private": fused_private,
        "candidate_scores": candidate_scores,
        "selected_model": selected_model,
        "oracle_private": oracle_private,
        "pool_size": len(pool),
    }


def _terminal(sig: str, task_id: str, outcome: str, reason: str) -> dict[str, Any]:
    row = {
        "task_id": task_id,
        "outcome": outcome,
        "passed": None,
        "score": None,
        "candidate_scores": {},
        "error_reason": reason,
    }
    if outcome == "excluded":
        save_cached(sig, row)
    return row


def _cost(engine: FusionEngine, model_id: str, usage: object) -> float | None:
    try:
        endpoint = engine.config.endpoint_for(model_id)
    except KeyError:
        return None
    return estimate_cost(endpoint, usage if isinstance(usage, dict) else None)


def _resolve_checker(value: str) -> CheckerMode:
    return value if value in ("exact", "token", "float", "case_insensitive") else "exact"


async def main() -> None:
    request = json.load(sys.stdin)
    subset = int(request.get("subset") or 10)
    samples = max(1, int(os.environ.get("LCB_SELECT_SAMPLES", "3")))
    temps = _temps()
    timeout = float(os.environ.get("LCB_TEST_TIMEOUT_S", "8"))
    concurrency = max(1, int(os.environ.get("LCB_CONCURRENCY", "4")))
    checker = _resolve_checker(os.environ.get("LCB_CHECKER", "exact"))
    config_path = os.environ.get("FUSIONKIT_BENCH_CONFIG")
    if not config_path:
        raise SystemExit("FUSIONKIT_BENCH_CONFIG must point at a FusionConfig YAML")

    config = load_config(config_path)
    engine = FusionEngine(config=config, clients=build_clients(config))
    sandbox = build_sandbox(SandboxConfig(backend=os.environ.get("BENCH_SANDBOX", "local")))
    problems = load_problems(
        subset,
        version=os.environ.get("LCB_VERSION", "release_v6"),
        min_date=os.environ.get("LCB_MIN_DATE", "2025-01-01"),
        difficulties={
            d.strip().lower()
            for d in os.environ.get("LCB_DIFFICULTY", "medium,hard").split(",")
            if d.strip()
        },
        manifest=load_manifest(os.environ.get("LCB_MANIFEST")),
    )
    sig = signature(engine, samples, temps)
    semaphore = asyncio.Semaphore(concurrency)
    log(
        f"execution-guided selection: {len(problems)} problems, {samples} samples x "
        f"{len(config.panel_models) or len(config.endpoints)} models, temps={temps}, sig={sig}"
    )

    rows = await asyncio.gather(
        *(
            evaluate_problem(
                engine,
                sandbox,
                problem,
                sig=sig,
                samples=samples,
                temps=temps,
                timeout=timeout,
                checker=checker,
                semaphore=semaphore,
            )
            for problem in problems
        )
    )
    scored = [r for r in rows if r["outcome"] == "scored"]
    envelope = {
        "suite": "livecodebench",
        "mount_mode": "fusion_behind_agent",
        "harness": "lcb-execution-guided-selection",
        "harness_version": f"select-bestofN-{samples}x",
        "model": request.get("gateway_model", "fusionkit/panel"),
        "resolved_tasks": len(scored),
        "total_tasks": len(rows),
        "passed_tasks": sum(1 for r in scored if r["passed"]),
        "cost_total_usd": round(sum(r.get("cost_usd") or 0.0 for r in rows), 6),
        "tasks": rows,
        "provenance": build_provenance(
            prompt_template=LCB_PROMPT_SUFFIX,
            model_versions={e.id: e.model for e in config.endpoints},
            dataset_revision=os.environ.get("LCB_VERSION", "release_v6"),
            extra={
                "method": "execution-guided best-of-N: select on public tests, grade on private",
                "samples_per_model": samples,
                "temps": temps,
                "scoring_version": SCORING_VERSION,
            },
        ),
        "metadata": {"samples_per_model": samples, "concurrency": concurrency},
    }
    json.dump(envelope, sys.stdout)


if __name__ == "__main__":
    asyncio.run(main())
