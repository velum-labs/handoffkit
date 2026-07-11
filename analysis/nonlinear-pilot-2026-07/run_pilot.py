"""Non-linear ensemble pilot: 4-wide + 2 execution-feedback repairs vs 6-wide select.

Pre-registered in preregistration.md. Matched budget of 6 cheap-model calls per
task; the non-linear arm spends the last two calls on execution-feedback repair
of the top failing candidates instead of two more diverse samples. Selection is
on PUBLIC tests, grading on PRIVATE tests (leakage-free), sandboxed execution.

Usage:
    uv run --package fusionkit-evals python analysis/nonlinear-pilot-2026-07/run_pilot.py

Env: OPENROUTER_API_KEY. Writes rows.jsonl (resumable) and results.json here.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from fusionkit_core.clients import build_clients
from fusionkit_core.config import load_config
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.providers import estimate_cost
from fusionkit_core.types import ChatMessage, Trajectory
from fusionkit_evals.bench_runtime import retry_async
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.livecodebench_data import (
    LCB_PROMPT_SUFFIX,
    decode_public_private,
)
from fusionkit_evals.sandbox import Sandbox, SandboxConfig, build_sandbox
from hyperkit.stats import mcnemar, wilson_interval

HERE = Path(__file__).parent
ROWS_PATH = HERE / "rows.jsonl"
RESULTS_PATH = HERE / "results.json"

SUBSET = int(os.environ.get("PILOT_SUBSET", "30"))
WIDE_TEMPS = [0.2, 0.6, 0.9]  # linear arm: both models at all three temps
NARROW_TEMPS = [0.2, 0.6]  # nonlinear arm: both models at the first two temps
REPAIR_MODEL = "terminus"
REPAIR_BUDGET = 2
TEST_TIMEOUT_S = 8.0
CONCURRENCY = int(os.environ.get("PILOT_CONCURRENCY", "3"))
SPEND_CAP_USD = 5.0

REPAIR_INSTRUCTIONS = (
    "The following Python program is a failing attempt at the problem above. "
    "Diagnose the bug using the execution feedback, then respond with ONLY a "
    "single Python code block containing the complete corrected program. The "
    "program must read from standard input and write the answer to standard "
    "output."
)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


LCB_TEST6_URL = (
    "https://huggingface.co/datasets/livecodebench/code_generation_lite/resolve/main/test6.jsonl"
)


def load_problems_stream(subset: int, *, min_date: str = "2025-01-01") -> list[dict[str, Any]]:
    """Load the newest LCB problems by streaming the v6 increment file.

    Same predicate and ordering as ``fusionkit_evals.livecodebench_data.load_problems``
    (difficulty medium/hard, contest_date >= min_date,     stdin-only public tests, no
    starter code, sorted newest first). The HF ``datasets`` loader OOMs on this
    machine materializing the full release (multi-GB private-test blobs), so we
    stream ``test6.jsonl`` line by line instead; the newest-first head of the
    release lives entirely in this file, so the selection is identical.
    """
    cache = Path.home() / ".cache" / "fusionkit-bench" / "lcb-test6.jsonl"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        log(f"downloading {LCB_TEST6_URL} ...")
        tmp = cache.with_suffix(".tmp")
        urllib.request.urlretrieve(LCB_TEST6_URL, tmp)
        tmp.replace(cache)
    selected: list[dict[str, Any]] = []
    with cache.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if (row.get("difficulty") or "").lower() not in {"medium", "hard"}:
                continue
            if str(row.get("contest_date") or "") < min_date:
                continue
            try:
                public = json.loads(row["public_test_cases"])
            except (KeyError, json.JSONDecodeError, TypeError):
                continue
            if any(tc.get("testtype") != "stdin" for tc in public):
                continue
            if row.get("starter_code"):
                continue
            selected.append(row)
    selected.sort(key=lambda r: str(r.get("contest_date")), reverse=True)
    chosen = selected[:subset]
    log(f"selected {len(chosen)} problems (newest-first from test6.jsonl, >= {min_date})")
    return chosen


class Candidate:
    def __init__(self, source: str, model_id: str, code: str, cost: float) -> None:
        self.source = source  # e.g. "terminus@0.2" or "repair(terminus<-qwen3@0.6)"
        self.model_id = model_id
        self.code = code
        self.cost = cost
        self.public_passed = 0
        self.public_total = 0
        self.public_all = False
        self.first_failure: dict[str, Any] | None = None
        self.private_pass: bool | None = None

    def score_public(self, sandbox: Sandbox, public: list[dict[str, str]]) -> None:
        run = verify_solution(sandbox, self.code, public, timeout_s=TEST_TIMEOUT_S)
        self.public_passed = sum(1 for t in run.per_test if t.get("passed"))
        self.public_total = len(public)
        self.public_all = run.passed
        if not run.passed and run.per_test:
            failed = next((t for t in run.per_test if not t.get("passed")), None)
            if failed is not None:
                index = failed["index"]
                test = public[index]
                result = sandbox.run(self.code, test.get("input", ""), timeout_s=TEST_TIMEOUT_S)
                self.first_failure = {
                    "input": test.get("input", "")[:2000],
                    "expected": test.get("output", "")[:2000],
                    "actual": result.stdout[:2000],
                    "stderr": result.stderr[:1000],
                    "timed_out": result.timed_out,
                }

    def grade_private(self, sandbox: Sandbox, private: list[dict[str, str]]) -> bool:
        if self.private_pass is None:
            self.private_pass = verify_solution(
                sandbox, self.code, private, timeout_s=TEST_TIMEOUT_S
            ).passed
        return self.private_pass


def select(candidates: list[Candidate]) -> Candidate:
    """Execution-guided selection: (passes all public, public passed), earliest wins."""
    best = candidates[0]
    best_key = (-1, -1)
    for candidate in candidates:
        key = (1 if candidate.public_all else 0, candidate.public_passed)
        if key > best_key:
            best_key = key
            best = candidate
    return best


def _cost(engine: FusionEngine, model_id: str, trajectory: Trajectory) -> float:
    endpoint = engine.config.endpoint_for(model_id)
    return estimate_cost(endpoint, trajectory.metadata.get("usage")) or 0.0


async def sample_candidates(
    engine: FusionEngine, prompt: str, temps: list[float]
) -> list[Candidate]:
    messages = [ChatMessage(role="user", content=prompt)]
    out: list[Candidate] = []
    for model_id in engine.config.panel_models:
        trajectories = await retry_async(
            lambda m=model_id: engine.producer.generate_self_fusion(
                m, messages, engine.config.sampling, temps, len(temps)
            ),
            attempts=3,
        )
        for temp, trajectory in zip(temps, trajectories, strict=True):
            if trajectory.status != "succeeded":
                raise RuntimeError(
                    f"{model_id}@{temp}: {trajectory.metadata.get('error_message')}"
                )
            out.append(
                Candidate(
                    source=f"{model_id}@{temp}",
                    model_id=model_id,
                    code=extract_code(trajectory.content).code,
                    cost=_cost(engine, model_id, trajectory),
                )
            )
    return out


async def repair_candidate(
    engine: FusionEngine, prompt: str, candidate: Candidate
) -> Candidate:
    failure = candidate.first_failure or {}
    feedback_lines = [
        prompt,
        "",
        REPAIR_INSTRUCTIONS,
        "",
        "```python",
        candidate.code,
        "```",
        "",
        "Execution feedback on a public test:",
        f"stdin:\n{failure.get('input', '(unavailable)')}",
        f"expected stdout:\n{failure.get('expected', '(unavailable)')}",
        f"actual stdout:\n{failure.get('actual', '')}",
    ]
    if failure.get("stderr"):
        feedback_lines.append(f"stderr:\n{failure['stderr']}")
    if failure.get("timed_out"):
        feedback_lines.append("The program TIMED OUT on this test (8s limit).")
    feedback_lines.append(
        f"Public tests passed: {candidate.public_passed}/{candidate.public_total}."
    )
    messages = [ChatMessage(role="user", content="\n".join(feedback_lines))]
    trajectory = await retry_async(
        lambda: engine.producer.generate_single(
            REPAIR_MODEL, messages, engine.config.sampling
        ),
        attempts=3,
    )
    return Candidate(
        source=f"repair({REPAIR_MODEL}<-{candidate.source})",
        model_id=REPAIR_MODEL,
        code=extract_code(trajectory.content).code,
        cost=_cost(engine, REPAIR_MODEL, trajectory),
    )


async def evaluate_problem(
    engine: FusionEngine,
    sandbox: Sandbox,
    problem: dict[str, Any],
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    task_id = str(problem.get("question_id"))
    public, private = decode_public_private(problem, 0)
    if not public or not private:
        return {"task_id": task_id, "outcome": "excluded", "reason": "missing tests"}
    prompt = (problem.get("question_content") or "") + LCB_PROMPT_SUFFIX

    async with semaphore:
        started = time.monotonic()
        try:
            wide = await sample_candidates(engine, prompt, WIDE_TEMPS)
        except Exception as exc:  # noqa: BLE001
            return {"task_id": task_id, "outcome": "provider_error", "reason": str(exc)[:400]}

        await asyncio.to_thread(lambda: [c.score_public(sandbox, public) for c in wide])

        narrow = [c for c in wide if float(c.source.rsplit("@", 1)[1]) in NARROW_TEMPS]
        repairs: list[Candidate] = []
        early_exit = any(c.public_all for c in narrow)
        if not early_exit:
            targets = sorted(narrow, key=lambda c: -c.public_passed)[:REPAIR_BUDGET]
            try:
                repairs = list(
                    await asyncio.gather(
                        *(repair_candidate(engine, prompt, c) for c in targets)
                    )
                )
            except Exception as exc:  # noqa: BLE001
                return {
                    "task_id": task_id,
                    "outcome": "provider_error",
                    "reason": f"repair: {exc}"[:400],
                }
            await asyncio.to_thread(
                lambda: [c.score_public(sandbox, public) for c in repairs]
            )
        latency = time.monotonic() - started

    linear_sel = select(wide)
    nonlinear_sel = select(narrow + repairs)

    # Grade every candidate on private tests off the event loop (subprocess-heavy);
    # failing candidates short-circuit at the first failing test so this is cheap.
    await asyncio.to_thread(
        lambda: [c.grade_private(sandbox, private) for c in wide + repairs]
    )

    def grade(candidate: Candidate) -> bool:
        return candidate.grade_private(sandbox, private)
    solo = {
        c.source: grade(c) for c in wide if c.source.endswith("@0.2")
    }
    row = {
        "task_id": task_id,
        "outcome": "scored",
        "latency_s": round(latency, 2),
        "arms": {
            "solo-terminus": solo.get("terminus@0.2"),
            "solo-qwen3": solo.get("qwen3@0.2"),
            "linear-6wide": grade(linear_sel),
            "nonlinear-4+2": grade(nonlinear_sel),
            "oracle-6wide": any(grade(c) for c in wide),
        },
        "selected": {"linear": linear_sel.source, "nonlinear": nonlinear_sel.source},
        "early_exit": early_exit,
        "repairs": [
            {
                "source": c.source,
                "public_all": c.public_all,
                "public_passed": c.public_passed,
                "private_pass": grade(c) if c.public_all else None,
            }
            for c in repairs
        ],
        "sampled_public_all_private": [
            grade(c) for c in wide if c.public_all
        ],
        "cost": {
            "linear-6wide": round(sum(c.cost for c in wide), 6),
            "nonlinear-4+2": round(
                sum(c.cost for c in narrow) + sum(c.cost for c in repairs), 6
            ),
        },
    }
    arms = row["arms"]
    log(
        f"  {task_id}: linear={_pf(arms['linear-6wide'])} "
        f"nonlinear={_pf(arms['nonlinear-4+2'])} "
        f"solo-t={_pf(arms['solo-terminus'])} oracle={_pf(arms['oracle-6wide'])} "
        f"repairs={len(repairs)} early_exit={early_exit}"
    )
    return row


def _pf(value: bool | None) -> str:
    return "P" if value else "F" if value is not None else "?"


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [r for r in rows if r.get("outcome") == "scored"]
    arms = ["solo-terminus", "solo-qwen3", "linear-6wide", "nonlinear-4+2", "oracle-6wide"]
    summary: dict[str, Any] = {"n": len(scored), "arms": {}}
    for arm in arms:
        passes = sum(1 for r in scored if r["arms"].get(arm))
        ci = wilson_interval(passes, len(scored))
        summary["arms"][arm] = {
            "passed": passes,
            "rate": round(ci.estimate, 4),
            "wilson95": [round(ci.low, 4), round(ci.high, 4)],
        }
    for baseline in ["linear-6wide", "solo-terminus"]:
        result = mcnemar(
            [bool(r["arms"][baseline]) for r in scored],
            [bool(r["arms"]["nonlinear-4+2"]) for r in scored],
        )
        summary[f"mcnemar_nonlinear_vs_{baseline}"] = {
            "wins": result.wins,
            "losses": result.losses,
            "p": round(result.p_value, 4),
        }
    repair_calls = [rep for r in scored for rep in r.get("repairs", [])]
    conversions = [rep for rep in repair_calls if rep["public_all"]]
    repaired_private = [
        rep["private_pass"] for rep in conversions if rep["private_pass"] is not None
    ]
    sampled_private = [p for r in scored for p in r.get("sampled_public_all_private", [])]
    summary["mechanism"] = {
        "repair_calls": len(repair_calls),
        "repair_conversions_public": len(conversions),
        "repair_conversion_rate": round(len(conversions) / len(repair_calls), 4)
        if repair_calls
        else None,
        "repaired_public_pass_private_rate": round(
            sum(repaired_private) / len(repaired_private), 4
        )
        if repaired_private
        else None,
        "sampled_public_pass_private_rate": round(
            sum(sampled_private) / len(sampled_private), 4
        )
        if sampled_private
        else None,
        "early_exit_rate": round(
            sum(1 for r in scored if r.get("early_exit")) / len(scored), 4
        )
        if scored
        else None,
    }
    summary["cost_usd"] = {
        "linear-6wide": round(sum(r["cost"]["linear-6wide"] for r in scored), 4),
        "nonlinear-4+2": round(sum(r["cost"]["nonlinear-4+2"] for r in scored), 4),
    }
    summary["errors"] = [r for r in rows if r.get("outcome") != "scored"]
    return summary


async def main() -> None:
    config = load_config(HERE / "config.panel.yaml")
    engine = FusionEngine(config=config, clients=build_clients(config))
    sandbox = build_sandbox(SandboxConfig(backend="local"))
    problems = load_problems_stream(SUBSET, min_date="2025-01-01")

    done: dict[str, dict[str, Any]] = {}
    if ROWS_PATH.exists():
        for line in ROWS_PATH.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("outcome") == "scored":
                done[row["task_id"]] = row
    log(f"pilot: {len(problems)} problems, {len(done)} cached rows")

    semaphore = asyncio.Semaphore(CONCURRENCY)
    spent = 0.0
    rows: list[dict[str, Any]] = list(done.values())
    pending = [p for p in problems if str(p.get("question_id")) not in done]

    with ROWS_PATH.open("a", encoding="utf-8") as sink:
        tasks = [
            asyncio.create_task(evaluate_problem(engine, sandbox, problem, semaphore))
            for problem in pending
        ]
        for task in asyncio.as_completed(tasks):
            row = await task
            rows.append(row)
            sink.write(json.dumps(row) + "\n")
            sink.flush()
            if row.get("outcome") == "scored":
                spent += row["cost"]["linear-6wide"] + row["cost"]["nonlinear-4+2"]
                if spent > SPEND_CAP_USD:
                    log(f"SPEND CAP HIT (${spent:.2f} > ${SPEND_CAP_USD}), aborting")
                    for other in tasks:
                        other.cancel()
                    break

    summary = summarize(rows)
    RESULTS_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
