"""Decision-only prompt tuning over a frozen candidate bank.

Selects the judge-decidable subset (candidates disagree), splits it into a dev set
the optimizer sees and a held-out val set used only for promotion, replays just
judge+synth over cached candidates for each prompt variant, verifies by
execution, and gates acceptance with a paired McNemar test. The LLM optimizer is
pluggable (a stub proposer is used in tests).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Protocol

from fusionkit_core.clients import ChatClient
from fusionkit_core.config import PromptOverrides, SamplingConfig
from fusionkit_core.judge import JudgeSynthesizer
from fusionkit_core.types import ChatMessage, Trajectory
from pydantic import BaseModel, Field

from fusionkit_evals.bench_stats import wilson_interval
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.candidate_bank import BankTask, CandidateBank
from fusionkit_evals.checkers import CheckerMode
from fusionkit_evals.code_extract import extract_code
from fusionkit_evals.sandbox import Sandbox

TunableRole = str  # one of: "synthesizer_system", "judge_system"


class PromptVariant(BaseModel):
    judge_system: str | None = None
    synthesizer_system: str | None = None

    def to_overrides(self) -> PromptOverrides:
        return PromptOverrides(
            judge_system=self.judge_system,
            synthesizer_system=self.synthesizer_system,
        )

    def with_role(self, role: TunableRole, text: str) -> PromptVariant:
        return self.model_copy(update={role: text})

    def role_text(self, role: TunableRole) -> str | None:
        return getattr(self, role)

    def hash(self) -> str:
        return hashlib.sha256(self.model_dump_json().encode()).hexdigest()[:16]


class TaskSplit(BaseModel):
    dev: list[str] = Field(default_factory=list)
    val: list[str] = Field(default_factory=list)
    regression_guard: list[str] = Field(default_factory=list)


class PerTaskResult(BaseModel):
    passed: bool
    fused_output: str = ""


class PromptEval(BaseModel):
    prompt_hash: str
    n: int
    successes: int
    score: float
    ci_low: float
    ci_high: float
    passes: dict[str, bool] = Field(default_factory=dict)


class McNemarResult(BaseModel):
    wins: int
    losses: int
    statistic: float | None = None
    significant: bool = False


class TrialRecord(BaseModel):
    iteration: int
    role: TunableRole
    prompt_hash: str
    dev_score: float
    wins: int
    losses: int
    accepted: bool


class TuningResult(BaseModel):
    role: TunableRole
    best_variant: PromptVariant
    baseline_dev: PromptEval
    best_dev: PromptEval
    baseline_val: PromptEval
    best_val: PromptEval
    trials: list[TrialRecord] = Field(default_factory=list)


# --- subset + split ----------------------------------------------------------


def select_decision_tasks(bank: CandidateBank) -> list[BankTask]:
    return [task for task in bank.tasks if task.is_decision_task]


def regression_guard_tasks(bank: CandidateBank) -> list[BankTask]:
    return [
        task
        for task in bank.tasks
        if task.candidates and task.n_pass == len(task.candidates)
    ]


def split_dev_val(
    tasks: Sequence[BankTask],
    *,
    val_fraction: float = 0.4,
    seed: int = 0,
) -> TaskSplit:
    ordered = sorted(task.task_id for task in tasks)
    rng = random.Random(seed)
    rng.shuffle(ordered)
    val_count = max(1, int(round(len(ordered) * val_fraction))) if ordered else 0
    val = sorted(ordered[:val_count])
    dev = sorted(ordered[val_count:])
    return TaskSplit(dev=dev, val=val)


# --- replay evaluator --------------------------------------------------------


class TunerRuntime:
    """Bundles everything replay needs (clients are not pydantic-serializable)."""

    def __init__(
        self,
        *,
        clients: Mapping[str, ChatClient],
        judge_id: str,
        synth_id: str,
        bank_signature: str,
        sandbox: Sandbox,
        cache_dir: Path,
        judge_sampling: SamplingConfig,
        synth_sampling: SamplingConfig,
        checker_mode: CheckerMode = "exact",
        test_timeout_s: float = 8.0,
        concurrency: int = 4,
    ) -> None:
        self.clients = dict(clients)
        self.judge_id = judge_id
        self.synth_id = synth_id
        self.bank_signature = bank_signature
        self.sandbox = sandbox
        self.cache_dir = Path(cache_dir)
        self.judge_sampling = judge_sampling
        self.synth_sampling = synth_sampling
        self.checker_mode: CheckerMode = checker_mode
        self.test_timeout_s = test_timeout_s
        self.semaphore = asyncio.Semaphore(max(1, concurrency))

    def _sampling_hash(self) -> str:
        payload = {
            "judge": self.judge_sampling.model_dump(mode="json"),
            "synth": self.synth_sampling.model_dump(mode="json"),
            "judge_id": self.judge_id,
            "synth_id": self.synth_id,
            "checker": self.checker_mode,
            "timeout": self.test_timeout_s,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]

    def _cache_path(self, prompt_hash: str, task_id: str) -> Path:
        return (
            self.cache_dir
            / self.bank_signature
            / f"{prompt_hash}__{self._sampling_hash()}"
            / f"{task_id}.json"
        )


async def replay_task(
    runtime: TunerRuntime,
    task: BankTask,
    variant: PromptVariant,
) -> PerTaskResult:
    candidates = [
        Trajectory(id=f"cand_{index}", model_id=cand.model_id, content=cand.content)
        for index, cand in enumerate(task.candidates)
    ]
    synthesizer = JudgeSynthesizer(variant.to_overrides())
    result = await synthesizer.fuse(
        [ChatMessage(role="user", content=task.prompt)],
        candidates,
        judge_client=runtime.clients[runtime.judge_id],
        synthesizer_client=runtime.clients[runtime.synth_id],
        sampling=runtime.synth_sampling,
        tools=None,
    )
    answer = result.response.content
    code = extract_code(answer).code
    run = await asyncio.to_thread(
        verify_solution,
        runtime.sandbox,
        code,
        task.tests,
        timeout_s=runtime.test_timeout_s,
        checker_mode=runtime.checker_mode,
    )
    return PerTaskResult(passed=run.passed, fused_output=answer[:4000])


async def evaluate_variant(
    runtime: TunerRuntime,
    variant: PromptVariant,
    tasks: Sequence[BankTask],
) -> PromptEval:
    prompt_hash = variant.hash()

    async def eval_one(task: BankTask) -> tuple[str, PerTaskResult]:
        cached = _load_cached(runtime._cache_path(prompt_hash, task.task_id))
        if cached is not None:
            return task.task_id, cached
        async with runtime.semaphore:
            result = await replay_task(runtime, task, variant)
        _save_cached(runtime._cache_path(prompt_hash, task.task_id), result)
        return task.task_id, result

    pairs = await asyncio.gather(*(eval_one(task) for task in tasks))
    passes = {task_id: result.passed for task_id, result in pairs}
    successes = sum(1 for value in passes.values() if value)
    n = len(passes)
    ci = wilson_interval(successes, n)
    return PromptEval(
        prompt_hash=prompt_hash,
        n=n,
        successes=successes,
        score=ci.estimate,
        ci_low=ci.low,
        ci_high=ci.high,
        passes=passes,
    )


def mcnemar(incumbent: Mapping[str, bool], candidate: Mapping[str, bool]) -> McNemarResult:
    """Paired test on per-task pass/fail; wins = candidate fixed an incumbent failure."""

    wins = sum(1 for key, value in candidate.items() if value and not incumbent.get(key, False))
    losses = sum(
        1 for key, value in candidate.items() if not value and incumbent.get(key, False)
    )
    discordant = wins + losses
    if discordant == 0:
        return McNemarResult(wins=0, losses=0, statistic=None, significant=False)
    statistic = (abs(wins - losses) - 1) ** 2 / discordant  # continuity-corrected, 1 dof
    significant = statistic >= 3.841 and wins > losses  # chi-square p < 0.05
    return McNemarResult(wins=wins, losses=losses, statistic=statistic, significant=significant)


# --- optimizer ---------------------------------------------------------------


class FailureExemplar(BaseModel):
    task_id: str
    prompt: str
    fused_output: str
    passing_candidate: str
    failing_candidate: str


class PromptProposer(Protocol):
    async def propose(
        self,
        *,
        role: TunableRole,
        current_prompt: str,
        trajectory: Sequence[tuple[str, float]],
        failures: Sequence[FailureExemplar],
    ) -> str: ...


class StubProposer:
    """Deterministic proposer for tests: yields a fixed list of prompts."""

    def __init__(self, proposals: Sequence[str]) -> None:
        self._proposals = list(proposals)
        self._index = 0

    async def propose(
        self,
        *,
        role: TunableRole,
        current_prompt: str,
        trajectory: Sequence[tuple[str, float]],
        failures: Sequence[FailureExemplar],
    ) -> str:
        proposal = self._proposals[min(self._index, len(self._proposals) - 1)]
        self._index += 1
        return proposal


class LLMProposer:
    def __init__(self, client: ChatClient, sampling: SamplingConfig) -> None:
        self._client = client
        self._sampling = sampling

    async def propose(
        self,
        *,
        role: TunableRole,
        current_prompt: str,
        trajectory: Sequence[tuple[str, float]],
        failures: Sequence[FailureExemplar],
    ) -> str:
        response = await self._client.chat(
            [
                ChatMessage(role="system", content=_OPTIMIZER_SYSTEM),
                ChatMessage(
                    role="user",
                    content=_optimizer_user_prompt(role, current_prompt, trajectory, failures),
                ),
            ],
            self._sampling,
        )
        return _strip_fences(response.content)


async def optimize(
    runtime: TunerRuntime,
    *,
    dev_tasks: Sequence[BankTask],
    val_tasks: Sequence[BankTask],
    proposer: PromptProposer,
    base_variant: PromptVariant | None = None,
    role: TunableRole = "synthesizer_system",
    max_iterations: int = 8,
    patience: int = 3,
) -> TuningResult:
    base = base_variant or PromptVariant()
    dev_by_id = {task.task_id: task for task in dev_tasks}
    incumbent = base
    incumbent_eval = await evaluate_variant(runtime, base, dev_tasks)
    baseline_dev = incumbent_eval
    trajectory: list[tuple[str, float]] = [
        (incumbent.role_text(role) or "<default>", incumbent_eval.score)
    ]
    trials: list[TrialRecord] = []
    no_improve = 0
    for iteration in range(max_iterations):
        failures = _collect_failures(dev_by_id, incumbent_eval)
        proposed = await proposer.propose(
            role=role,
            current_prompt=incumbent.role_text(role) or "",
            trajectory=trajectory,
            failures=failures,
        )
        candidate = incumbent.with_role(role, proposed)
        candidate_eval = await evaluate_variant(runtime, candidate, dev_tasks)
        comparison = mcnemar(incumbent_eval.passes, candidate_eval.passes)
        accepted = (
            candidate_eval.score > incumbent_eval.score
            and comparison.wins > comparison.losses
        )
        trials.append(
            TrialRecord(
                iteration=iteration,
                role=role,
                prompt_hash=candidate_eval.prompt_hash,
                dev_score=candidate_eval.score,
                wins=comparison.wins,
                losses=comparison.losses,
                accepted=accepted,
            )
        )
        if accepted:
            incumbent = candidate
            incumbent_eval = candidate_eval
            trajectory.append((proposed, candidate_eval.score))
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= patience:
                break
    best_val = await evaluate_variant(runtime, incumbent, val_tasks)
    baseline_val = await evaluate_variant(runtime, base, val_tasks)
    return TuningResult(
        role=role,
        best_variant=incumbent,
        baseline_dev=baseline_dev,
        best_dev=incumbent_eval,
        baseline_val=baseline_val,
        best_val=best_val,
        trials=trials,
    )


def _collect_failures(
    dev_by_id: Mapping[str, BankTask],
    incumbent_eval: PromptEval,
    *,
    limit: int = 4,
) -> list[FailureExemplar]:
    exemplars: list[FailureExemplar] = []
    for task_id, passed in incumbent_eval.passes.items():
        if passed:
            continue
        task = dev_by_id.get(task_id)
        if task is None:
            continue
        passing = next((c.content for c in task.candidates if c.passed), "")
        failing = next((c.content for c in task.candidates if not c.passed), "")
        exemplars.append(
            FailureExemplar(
                task_id=task_id,
                prompt=task.prompt[:1500],
                fused_output="",
                passing_candidate=passing[:1500],
                failing_candidate=failing[:1500],
            )
        )
        if len(exemplars) >= limit:
            break
    return exemplars


_OPTIMIZER_SYSTEM = (
    "You optimize a single system prompt for one role in a model-fusion coding "
    "system (a judge that analyzes candidate solutions and a synthesizer that writes "
    "the final program). You are given the current prompt, the score history of past "
    "prompts, and failure cases where the fused answer failed the tests even though a "
    "candidate solution passed. Propose ONE improved system prompt that will make the "
    "fused answer pass more often. Output ONLY the new prompt text, no commentary."
)


def _optimizer_user_prompt(
    role: TunableRole,
    current_prompt: str,
    trajectory: Sequence[tuple[str, float]],
    failures: Sequence[FailureExemplar],
) -> str:
    history = "\n".join(f"- score {score:.3f}" for _prompt, score in trajectory[-6:])
    failure_blocks = []
    for failure in failures:
        failure_blocks.append(
            f"TASK {failure.task_id}\nPROMPT:\n{failure.prompt}\n"
            f"A PASSING CANDIDATE:\n{failure.passing_candidate}\n"
            f"A FAILING CANDIDATE:\n{failure.failing_candidate}\n"
        )
    failures_text = "\n---\n".join(failure_blocks) or "(none)"
    return (
        f"ROLE: {role}\n\nCURRENT PROMPT:\n{current_prompt or '<built-in default>'}\n\n"
        f"SCORE HISTORY (recent):\n{history}\n\nFAILURE CASES:\n{failures_text}\n\n"
        "Return only the improved prompt."
    )


def _strip_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def _load_cached(path: Path) -> PerTaskResult | None:
    if not path.exists():
        return None
    try:
        return PerTaskResult.model_validate_json(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def _save_cached(path: Path, result: PerTaskResult) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(result.model_dump_json(), encoding="utf-8")
    tmp.replace(path)


__all__ = [
    "FailureExemplar",
    "LLMProposer",
    "McNemarResult",
    "PerTaskResult",
    "PromptEval",
    "PromptProposer",
    "PromptVariant",
    "StubProposer",
    "TaskSplit",
    "TrialRecord",
    "TunableRole",
    "TunerRuntime",
    "TuningResult",
    "evaluate_variant",
    "mcnemar",
    "optimize",
    "regression_guard_tasks",
    "replay_task",
    "select_decision_tasks",
    "split_dev_val",
]
