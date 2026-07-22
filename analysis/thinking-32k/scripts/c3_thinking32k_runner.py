from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

PHASE0_SCRIPT = Path(__file__).resolve().parents[2] / "phase0" / "scripts" / "c3_transfer_pilot.py"
SPEC = importlib.util.spec_from_file_location("c3_transfer_pilot_phase0", PHASE0_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {PHASE0_SCRIPT}")
c3 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = c3
SPEC.loader.exec_module(c3)


def failed_task_result(
    *,
    index: int,
    task: dict[str, Any],
    specs: list[Any],
    task_meta: dict[str, dict[str, Any]],
    phase: str,
    error_message: str,
) -> tuple[int, Any, list[dict[str, Any]], list[dict[str, Any]], float]:
    bank_candidates = []
    outcome_rows = []
    ledger_rows = []
    meta = task_meta[str(task["task_id"])]
    for spec in specs:
        bank_candidates.append(
            c3.BankCandidate(
                model_id=spec.endpoint_id,
                content="",
                passed=False,
            )
        )
        outcome_rows.append(
            {
                "task_id": task["task_id"],
                "cluster_key": meta["cluster_key"],
                "contest_date": meta["contest_date"],
                "difficulty": task.get("difficulty") or "",
                "endpoint_id": spec.endpoint_id,
                "provider": spec.provider,
                "model": spec.model,
                "call_status": "failed",
                "passed": 0,
                "prompt_tokens": None,
                "completion_tokens": None,
                "total_tokens": None,
                "estimated_cost_usd": None,
                "provider_cost_usd": None,
                "charged_cost_usd": 0.0,
                "latency_s": None,
                "error_message": error_message[:1000],
            }
        )
        ledger_rows.append(
            {
                "phase": phase,
                "task_id": task["task_id"],
                "endpoint_id": spec.endpoint_id,
                "provider": spec.provider,
                "model": spec.model,
                "status": "failed",
                "error_message": error_message[:1000],
                "charged_cost_usd": 0.0,
            }
        )
    print(
        f"{phase}: task {index} {task['task_id']} failed: {error_message[:200]}",
        file=sys.stderr,
        flush=True,
    )
    return (
        index,
        c3.BankTask(
            task_id=str(task["task_id"]),
            prompt=task["prompt"],
            tests=task["tests"],
            difficulty=task.get("difficulty"),
            candidates=bank_candidates,
        ),
        outcome_rows,
        ledger_rows,
        0.0,
    )


async def process_task(
    *,
    index: int,
    total: int,
    task: dict[str, Any],
    engine: Any,
    config: Any,
    endpoints: dict[str, Any],
    task_meta: dict[str, dict[str, Any]],
    test_timeout_s: float,
    phase: str,
) -> tuple[int, Any, list[dict[str, Any]], list[dict[str, Any]], float]:
    sandbox = c3.LocalSandbox()
    trajectories = await engine.producer.generate_panel(
        config.panel_models,
        [c3.ChatMessage(role="user", content=task["prompt"])],
        config.sampling,
    )
    bank_candidates = []
    outcome_rows = []
    ledger_rows = []
    task_cost = 0.0
    for trajectory in trajectories:
        endpoint = endpoints[trajectory.model_id]
        cost = c3.cost_record(endpoint, trajectory=trajectory)
        charged = cost.get("charged_cost_usd")
        if isinstance(charged, int | float):
            task_cost += float(charged)
        status = trajectory.status
        error_message = ""
        passed = False
        if status == "succeeded":
            code = c3.extract_code(trajectory.content).code
            run = c3.verify_solution(
                sandbox,
                code,
                task["tests"],
                timeout_s=test_timeout_s,
            )
            passed = run.passed
        else:
            error_message = str(trajectory.metadata.get("error_message") or "")[:1000]
        bank_candidates.append(
            c3.BankCandidate(
                model_id=trajectory.model_id,
                content=trajectory.content,
                passed=passed,
            )
        )
        meta = task_meta[str(task["task_id"])]
        outcome_rows.append(
            {
                "task_id": task["task_id"],
                "cluster_key": meta["cluster_key"],
                "contest_date": meta["contest_date"],
                "difficulty": task.get("difficulty") or "",
                "endpoint_id": trajectory.model_id,
                "provider": endpoint.provider,
                "model": endpoint.model,
                "call_status": status,
                "passed": int(passed),
                "prompt_tokens": cost.get("prompt_tokens"),
                "completion_tokens": cost.get("completion_tokens"),
                "total_tokens": cost.get("total_tokens"),
                "estimated_cost_usd": cost.get("estimated_cost_usd"),
                "provider_cost_usd": cost.get("provider_cost_usd"),
                "charged_cost_usd": cost.get("charged_cost_usd"),
                "latency_s": cost.get("latency_s"),
                "error_message": error_message,
            }
        )
        ledger_rows.append(
            {
                "phase": phase,
                "task_id": task["task_id"],
                "status": status,
                "error_message": error_message,
                **cost,
            }
        )
    print(
        f"{phase}: task {index}/{total} {task['task_id']} cost=${task_cost:.4f}",
        file=sys.stderr,
        flush=True,
    )
    return (
        index,
        c3.BankTask(
            task_id=str(task["task_id"]),
            prompt=task["prompt"],
            tests=task["tests"],
            difficulty=task.get("difficulty"),
            candidates=bank_candidates,
        ),
        outcome_rows,
        ledger_rows,
        task_cost,
    )


async def guarded_process_task(
    *,
    hard_task_timeout_s: float,
    specs: list[Any],
    **kwargs: Any,
) -> tuple[int, Any, list[dict[str, Any]], list[dict[str, Any]], float]:
    try:
        return await asyncio.wait_for(process_task(**kwargs), timeout=hard_task_timeout_s)
    except TimeoutError:
        return failed_task_result(
            index=kwargs["index"],
            task=kwargs["task"],
            specs=specs,
            task_meta=kwargs["task_meta"],
            phase=kwargs["phase"],
            error_message=f"hard task timeout after {hard_task_timeout_s:.0f}s",
        )
    except Exception as exc:
        return failed_task_result(
            index=kwargs["index"],
            task=kwargs["task"],
            specs=specs,
            task_meta=kwargs["task_meta"],
            phase=kwargs["phase"],
            error_message=f"{type(exc).__name__}: {exc}",
        )


def write_ledger_replace(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def persist_outputs(
    *,
    args: argparse.Namespace,
    signature: str,
    config: Any,
    bank_tasks_by_index: dict[int, Any],
    outcome_rows_by_index: dict[int, list[dict[str, Any]]],
    ledger_rows: list[dict[str, Any]],
) -> None:
    ordered_indexes = sorted(bank_tasks_by_index)
    bank = c3.CandidateBank(
        signature=signature,
        panel_models=config.panel_models,
        tasks=[bank_tasks_by_index[index] for index in ordered_indexes],
    )
    c3.save_bank(args.bank, bank)
    c3.write_outcomes(
        args.outcomes,
        [
            row
            for index in sorted(outcome_rows_by_index)
            for row in outcome_rows_by_index[index]
        ],
    )
    write_ledger_replace(args.ledger, ledger_rows)


async def build_bank(args: argparse.Namespace) -> int:
    specs = c3.model_specs(args.models.split(","), sonnet_model=args.sonnet_model)
    config = c3.fusion_config(
        specs,
        max_tokens=args.max_tokens,
        request_timeout_s=args.request_timeout_s,
    )
    clients = c3.build_clients(config)
    engine = c3.FusionEngine(config, clients)
    endpoints = c3.endpoint_by_id(config)
    if args.source_bank is not None:
        prepared = c3.prepared_tasks_from_bank(args.source_bank, manifest=args.tasks, subset=args.subset)
    else:
        problems = c3.selected_problem_rows(args.subset, min_date=args.min_date, version=args.version)
        c3.write_task_manifest(args.tasks, problems, version=args.version)
        prepared = c3.prepare_tasks(problems, max_tests=args.max_tests)
    if args.task_ids:
        requested = [task_id.strip() for task_id in args.task_ids.split(",") if task_id.strip()]
        requested_set = set(requested)
        prepared_by_id = {str(task["task_id"]): task for task in prepared}
        missing = [task_id for task_id in requested if task_id not in prepared_by_id]
        if missing:
            raise ValueError(f"requested task ids missing from source bank: {missing}")
        prepared = [prepared_by_id[task_id] for task_id in requested if task_id in requested_set]
    signature = hashlib.sha256(
        json.dumps(
            {
                "models": [(spec.endpoint_id, spec.provider, spec.model) for spec in specs],
                "tasks": [task["task_id"] for task in prepared],
                "prompt_suffix": c3.LCB_PROMPT_SUFFIX,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()[:16]
    task_meta = c3.read_task_manifest(args.tasks)
    cumulative_start = c3.total_spend(args.ledger)
    initial_ledger_rows = c3.load_ledger(args.ledger)
    observed_task_costs: list[float] = []
    bank_tasks_by_index: dict[int, Any] = {}
    outcome_rows_by_index: dict[int, list[dict[str, Any]]] = {}
    ledger_rows = list(initial_ledger_rows)
    batch_size = max(1, args.concurrency)
    pending: dict[asyncio.Task[tuple[int, Any, list[dict[str, Any]], list[dict[str, Any]], float]], int] = {}
    next_index = 1
    stopped_for_budget = False

    def projected_total() -> float | None:
        if observed_task_costs:
            remaining = len(prepared) - len(observed_task_costs)
            return cumulative_start + sum(observed_task_costs) + (
                sum(observed_task_costs) / len(observed_task_costs)
            ) * remaining
        return None

    def launch_available() -> None:
        nonlocal next_index, stopped_for_budget
        while next_index <= len(prepared) and len(pending) < batch_size and not stopped_for_budget:
            projected = projected_total()
            if projected is not None and projected > args.budget_usd:
                print(
                    f"stopping before task {next_index}: projected total ${projected:.4f} "
                    f"exceeds ${args.budget_usd:.2f}",
                    file=sys.stderr,
                    flush=True,
                )
                stopped_for_budget = True
                return
            task = prepared[next_index - 1]
            future = asyncio.create_task(
                guarded_process_task(
                    hard_task_timeout_s=args.hard_task_timeout_s,
                    specs=specs,
                    index=next_index,
                    total=len(prepared),
                    task=task,
                    engine=engine,
                    config=config,
                    endpoints=endpoints,
                    task_meta=task_meta,
                    test_timeout_s=args.test_timeout_s,
                    phase=args.phase,
                )
            )
            pending[future] = next_index
            next_index += 1

    launch_available()
    while pending:
        done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for future in done:
            pending.pop(future)
            index, bank_task, task_outcomes, task_ledger, task_cost = await future
            bank_tasks_by_index[index] = bank_task
            outcome_rows_by_index[index] = task_outcomes
            ledger_rows.extend(task_ledger)
            observed_task_costs.append(task_cost)
            persist_outputs(
                args=args,
                signature=signature,
                config=config,
                bank_tasks_by_index=bank_tasks_by_index,
                outcome_rows_by_index=outcome_rows_by_index,
                ledger_rows=ledger_rows,
            )
        launch_available()
    phase_cost = sum(
        float(row["charged_cost_usd"])
        for row in ledger_rows
        if isinstance(row.get("charged_cost_usd"), int | float)
    )
    print(
        json.dumps(
            {
                "bank": str(args.bank),
                "cumulative_cost_usd": c3.total_spend(args.ledger),
                "models": config.panel_models,
                "phase_cost_usd": phase_cost,
                "tasks": len(bank_tasks_by_index),
            },
            sort_keys=True,
        )
    )
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build-bank")
    c3.add_common(build)
    build.add_argument("--subset", type=int, default=60)
    build.add_argument("--min-date", default="2025-06-01")
    build.add_argument("--version", default="release_v6")
    build.add_argument("--max-tests", type=int, default=0)
    build.add_argument("--test-timeout-s", type=float, default=8.0)
    build.add_argument("--budget-usd", type=float, default=60.0)
    build.add_argument("--hard-task-timeout-s", type=float, default=3600.0)
    build.add_argument("--bank", type=Path, default=c3.DEFAULT_BANK)
    build.add_argument("--outcomes", type=Path, default=c3.DEFAULT_OUTCOMES)
    build.add_argument("--tasks", type=Path, default=c3.DEFAULT_TASKS)
    build.add_argument("--source-bank", type=Path, default=None)
    build.add_argument("--task-ids", default="")
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "build-bank":
        return asyncio.run(build_bank(args))
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
