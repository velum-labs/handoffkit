from __future__ import annotations

import json
from collections.abc import Sequence

from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint, SamplingConfig
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.types import ChatMessage
from fusionkit_evals.bench_verify import verify_solution
from fusionkit_evals.candidate_bank import (
    BankCandidate,
    BankTask,
    CandidateBank,
    PreparedTask,
    bank_signature,
    build_candidate_bank,
    load_bank,
    save_bank,
)
from fusionkit_evals.livecodebench_data import LCB_PROMPT_SUFFIX, decode_tests, prepare_tasks
from fusionkit_evals.prompt_tuning import (
    PromptVariant,
    StubProposer,
    TunerRuntime,
    evaluate_variant,
    mcnemar,
    optimize,
    regression_guard_tasks,
    select_decision_tasks,
    split_dev_val,
)
from fusionkit_evals.sandbox import LocalSandbox

CORRECT = "```python\nprint(int(input()) * 2)\n```"
WRONG = "```python\nprint(input())\n```"
DOUBLE_TEST = [{"input": "5", "output": "10", "testtype": "stdin"}]


class _PromptSensitiveFake(FakeModelClient):
    """Synth fake whose output is correct only when the system prompt has a marker."""

    def _next_content(self, messages: Sequence[ChatMessage], sampling: SamplingConfig) -> str:
        system = " ".join(m.content for m in messages if m.role == "system")
        return CORRECT if "FIXED" in system else WRONG


# --- verify_solution ---------------------------------------------------------


def test_verify_solution_pass_and_fail() -> None:
    sandbox = LocalSandbox()
    assert verify_solution(sandbox, "print(int(input())*2)", DOUBLE_TEST, timeout_s=10).passed
    assert not verify_solution(sandbox, "print(input())", DOUBLE_TEST, timeout_s=10).passed


# --- candidate bank ----------------------------------------------------------


def _panel_engine() -> FusionEngine:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="pass", model="m", base_url="http://x"),
            ModelEndpoint(id="fail", model="m", base_url="http://x"),
        ],
        default_model="pass",
        panel_models=["pass", "fail"],
        default_mode="panel",
    )
    clients = {
        "pass": FakeModelClient("pass", [CORRECT]),
        "fail": FakeModelClient("fail", [WRONG]),
    }
    return FusionEngine(config=config, clients=clients)


async def test_build_candidate_bank_records_candidate_pass() -> None:
    engine = _panel_engine()
    task = PreparedTask(task_id="d1", prompt="double", tests=DOUBLE_TEST, difficulty="easy")

    bank = await build_candidate_bank(
        engine, LocalSandbox(), [task], signature="sig", concurrency=1
    )

    assert len(bank.tasks) == 1
    bank_task = bank.tasks[0]
    assert bank_task.n_pass == 1
    assert bank_task.is_decision_task is True
    passed_by_model = {c.model_id: c.passed for c in bank_task.candidates}
    assert passed_by_model == {"pass": True, "fail": False}


def test_bank_signature_ignores_judge_config() -> None:
    engine = _panel_engine()
    sig1 = bank_signature(engine, prompt_suffix="X")
    engine.config.judge_model = "fail"  # judge change must not move the bank signature
    sig2 = bank_signature(engine, prompt_suffix="X")
    assert sig1 == sig2


def test_bank_round_trips(tmp_path) -> None:
    bank = _decision_bank(2)
    save_bank(tmp_path / "bank.json", bank)
    assert load_bank(tmp_path / "bank.json").tasks[0].task_id == bank.tasks[0].task_id


# --- subset selection + split ------------------------------------------------


def _decision_bank(n: int) -> CandidateBank:
    tasks = [
        BankTask(
            task_id=f"t{i}",
            prompt="double the input",
            tests=DOUBLE_TEST,
            candidates=[
                BankCandidate(model_id="a", content=CORRECT, passed=True),
                BankCandidate(model_id="b", content=WRONG, passed=False),
            ],
        )
        for i in range(n)
    ]
    # add an all-pass regression-guard task and an all-fail task
    tasks.append(
        BankTask(
            task_id="all_pass",
            prompt="p",
            tests=DOUBLE_TEST,
            candidates=[BankCandidate(model_id="a", content=CORRECT, passed=True)],
        )
    )
    tasks.append(
        BankTask(
            task_id="all_fail",
            prompt="p",
            tests=DOUBLE_TEST,
            candidates=[BankCandidate(model_id="a", content=WRONG, passed=False)],
        )
    )
    return CandidateBank(signature="sig", panel_models=["a", "b"], tasks=tasks)


def test_decision_and_regression_selection() -> None:
    bank = _decision_bank(3)
    decision = select_decision_tasks(bank)
    guard = regression_guard_tasks(bank)
    assert {t.task_id for t in decision} == {"t0", "t1", "t2"}
    assert {t.task_id for t in guard} == {"all_pass"}


def test_split_dev_val_is_deterministic_and_disjoint() -> None:
    decision = select_decision_tasks(_decision_bank(10))
    split_a = split_dev_val(decision, val_fraction=0.4, seed=0)
    split_b = split_dev_val(decision, val_fraction=0.4, seed=0)
    assert split_a == split_b
    assert set(split_a.dev).isdisjoint(split_a.val)
    assert len(split_a.dev) + len(split_a.val) == 10


# --- mcnemar -----------------------------------------------------------------


def test_mcnemar_counts_wins_and_losses() -> None:
    result = mcnemar({"a": False, "b": True, "c": True}, {"a": True, "b": True, "c": False})
    assert result.wins == 1  # a: fixed
    assert result.losses == 1  # c: broke
    assert result.significant is False


# --- replay evaluator + optimizer -------------------------------------------


def _runtime(tmp_path) -> TunerRuntime:
    clients = {
        "judge": FakeModelClient("judge", ["{}"]),
        "synth": _PromptSensitiveFake("synth"),
    }
    return TunerRuntime(
        clients=clients,
        judge_id="judge",
        synth_id="synth",
        bank_signature="sig",
        sandbox=LocalSandbox(),
        cache_dir=tmp_path / "cache",
        judge_sampling=SamplingConfig(temperature=0.0),
        synth_sampling=SamplingConfig(),
        concurrency=2,
    )


async def test_evaluate_variant_reflects_prompt(tmp_path) -> None:
    runtime = _runtime(tmp_path)
    tasks = select_decision_tasks(_decision_bank(3))

    baseline = await evaluate_variant(runtime, PromptVariant(), tasks)
    fixed = await evaluate_variant(
        runtime, PromptVariant(synthesizer_system="FIXED: write the correct program"), tasks
    )

    assert baseline.score == 0.0
    assert fixed.score == 1.0
    # second eval of the same variant is served from cache (file exists)
    cached_again = await evaluate_variant(runtime, PromptVariant(), tasks)
    assert cached_again.passes == baseline.passes


async def test_optimize_promotes_improved_prompt(tmp_path) -> None:
    runtime = _runtime(tmp_path)
    decision = select_decision_tasks(_decision_bank(8))
    split = split_dev_val(decision, val_fraction=0.4, seed=1)
    by_id = {t.task_id: t for t in decision}
    dev = [by_id[i] for i in split.dev]
    val = [by_id[i] for i in split.val]

    result = await optimize(
        runtime,
        dev_tasks=dev,
        val_tasks=val,
        proposer=StubProposer(["FIXED: synthesize the program that passes the tests"]),
        role="synthesizer_system",
        max_iterations=3,
        patience=2,
    )

    assert result.baseline_val.score == 0.0
    assert result.best_val.score == 1.0
    assert result.best_variant.synthesizer_system is not None
    assert "FIXED" in result.best_variant.synthesizer_system
    assert any(trial.accepted for trial in result.trials)


async def test_optimize_keeps_baseline_when_no_improvement(tmp_path) -> None:
    runtime = _runtime(tmp_path)
    decision = select_decision_tasks(_decision_bank(6))
    split = split_dev_val(decision, val_fraction=0.5, seed=2)
    by_id = {t.task_id: t for t in decision}
    dev = [by_id[i] for i in split.dev]
    val = [by_id[i] for i in split.val]

    result = await optimize(
        runtime,
        dev_tasks=dev,
        val_tasks=val,
        proposer=StubProposer(["this proposal has no marker so stays wrong"]),
        role="synthesizer_system",
        max_iterations=3,
        patience=2,
    )

    assert result.best_dev.score == result.baseline_dev.score == 0.0
    assert not any(trial.accepted for trial in result.trials)


def test_decode_tests_filters_to_stdin_and_caps() -> None:
    row = {
        "public_test_cases": json.dumps(
            [
                {"input": "1", "output": "2", "testtype": "stdin"},
                {"input": "x", "output": "y", "testtype": "functional"},
                {"input": "3", "output": "4", "testtype": "stdin"},
            ]
        )
    }
    assert len(decode_tests(row, 0)) == 2  # only stdin
    assert len(decode_tests(row, 1)) == 1  # capped


def test_prepare_tasks_builds_prompt_and_tests() -> None:
    problems = [
        {
            "question_id": "q1",
            "question_content": "do the thing",
            "difficulty": "medium",
            "public_test_cases": json.dumps(
                [{"input": "1", "output": "2", "testtype": "stdin"}]
            ),
        }
    ]
    prepared = prepare_tasks(problems, max_tests=0)
    assert prepared[0]["task_id"] == "q1"
    assert prepared[0]["prompt"].endswith(LCB_PROMPT_SUFFIX)
    assert prepared[0]["tests"] == [{"input": "1", "output": "2", "testtype": "stdin"}]
    assert prepared[0]["difficulty"] == "medium"


def test_prompt_variant_hash_and_with_role() -> None:
    base = PromptVariant()
    updated = base.with_role("synthesizer_system", "hello")
    assert updated.synthesizer_system == "hello"
    assert base.hash() != updated.hash()
    assert updated.to_overrides().synthesizer_system == "hello"
