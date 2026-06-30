"""Frozen candidate bank: panel candidates generated once, then reused.

Panel candidates are expensive and do not change when you tune the judge or
synthesizer prompt, so we generate them once per task and persist them. The prompt
tuner then replays only judge+synth over this bank, making each tuning iteration
cheap. The bank also records, per candidate, whether its code passes the task's
tests, which drives decision-subset selection and the oracle ceiling.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage
from pydantic import BaseModel, Field

from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.checkers import CheckerMode
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.sandbox import Sandbox


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class PreparedTask(BaseModel):
    task_id: str
    prompt: str
    tests: list[dict[str, str]] = Field(default_factory=list)
    difficulty: str | None = None


class BankCandidate(BaseModel):
    model_id: str
    content: str
    passed: bool


class BankTask(BaseModel):
    task_id: str
    prompt: str
    tests: list[dict[str, str]]
    difficulty: str | None = None
    candidates: list[BankCandidate] = Field(default_factory=list)

    @property
    def n_pass(self) -> int:
        return sum(1 for c in self.candidates if c.passed)

    @property
    def oracle_pass(self) -> bool:
        return self.n_pass > 0

    @property
    def is_decision_task(self) -> bool:
        # Judge-decidable: at least one candidate passes and at least one fails.
        return 0 < self.n_pass < len(self.candidates)


class CandidateBank(BaseModel):
    signature: str
    panel_models: list[str] = Field(default_factory=list)
    tasks: list[BankTask] = Field(default_factory=list)


def bank_signature(
    engine: FusionEngine,
    *,
    prompt_suffix: str,
    extra: dict[str, Any] | None = None,
) -> str:
    """Stable id over only the things that affect candidates (not judge/synth)."""

    config = engine.config
    payload = {
        "endpoints": sorted((e.id, e.model, e.provider) for e in config.endpoints),
        "panel_models": sorted(config.panel_models),
        "solver_sampling": config.sampling.model_dump(mode="json"),
        "prompt_suffix": prompt_suffix,
        **(extra or {}),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def panel_model_ids(engine: FusionEngine) -> list[str]:
    if engine.config.panel_models:
        return list(engine.config.panel_models)
    return [endpoint.id for endpoint in engine.config.endpoints]


async def build_candidate_bank(
    engine: FusionEngine,
    sandbox: Sandbox,
    tasks: Sequence[PreparedTask],
    *,
    signature: str,
    checker_mode: CheckerMode = "exact",
    test_timeout_s: float = 8.0,
    concurrency: int = 4,
) -> CandidateBank:
    models = panel_model_ids(engine)
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def build_one(task: PreparedTask) -> BankTask | None:
        async with semaphore:
            try:
                candidates = await engine.producer.generate_panel(
                    models,
                    [ChatMessage(role="user", content=task.prompt)],
                    engine.config.sampling,
                )
            except Exception as exc:  # noqa: BLE001 - skip tasks that fail to generate
                _log(f"  {task.task_id}: candidate generation failed, skipping ({exc})")
                return None
        bank_candidates = await asyncio.to_thread(
            _verify_candidates, sandbox, candidates, task, checker_mode, test_timeout_s
        )
        return BankTask(
            task_id=task.task_id,
            prompt=task.prompt,
            tests=task.tests,
            difficulty=task.difficulty,
            candidates=bank_candidates,
        )

    built = await asyncio.gather(*(build_one(task) for task in tasks))
    bank_tasks = [task for task in built if task is not None]
    _log(f"built candidate bank: {len(bank_tasks)} tasks, panel={models}")
    return CandidateBank(signature=signature, panel_models=models, tasks=bank_tasks)


def _verify_candidates(
    sandbox: Sandbox,
    candidates: Sequence[Any],
    task: PreparedTask,
    checker_mode: CheckerMode,
    test_timeout_s: float,
) -> list[BankCandidate]:
    results = []
    for candidate in candidates:
        code = extract_code(candidate.content).code
        run = verify_solution(
            sandbox, code, task.tests, timeout_s=test_timeout_s, checker_mode=checker_mode
        )
        results.append(
            BankCandidate(model_id=candidate.model_id, content=candidate.content, passed=run.passed)
        )
    return results


def save_bank(path: str | Path, bank: CandidateBank) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(bank.model_dump_json(), encoding="utf-8")


def load_bank(path: str | Path) -> CandidateBank:
    return CandidateBank.model_validate_json(Path(path).read_text(encoding="utf-8"))


__all__ = [
    "BankCandidate",
    "BankTask",
    "CandidateBank",
    "PreparedTask",
    "bank_signature",
    "build_candidate_bank",
    "load_bank",
    "panel_model_ids",
    "save_bank",
]
