"""Shared execution verification for coding benchmarks and the tuning loop.

Runs a program against a list of stdin/stdout tests in a sandbox and scores it
all-or-nothing (pass@1), using a configurable output checker. Extracted from the
LiveCodeBench adapter so the candidate-bank builder and the prompt tuner verify
solutions exactly the same way the benchmark does.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from fusionkit_evals.checkers import CheckerMode, check_output
from fusionkit_evals.sandbox import Sandbox


class SolutionRun(BaseModel):
    passed: bool
    per_test: list[dict[str, Any]] = Field(default_factory=list)
    stderr: str = ""


def verify_solution(
    sandbox: Sandbox,
    code: str,
    tests: list[dict[str, str]],
    *,
    timeout_s: float,
    checker_mode: CheckerMode = "exact",
) -> SolutionRun:
    """Execute ``code`` against every test; pass only if all tests pass."""

    if not code.strip() or not tests:
        return SolutionRun(passed=False)
    per_test: list[dict[str, Any]] = []
    stderr_sample = ""
    for index, test in enumerate(tests):
        expected = test.get("output", "")
        result = sandbox.run(code, test.get("input", ""), timeout_s=timeout_s)
        ok = result.ok and check_output(expected, result.stdout, mode=checker_mode)
        per_test.append(
            {
                "index": index,
                "passed": ok,
                "returncode": result.returncode,
                "timed_out": result.timed_out,
                "output_truncated": result.output_truncated,
            }
        )
        if not ok:
            if result.stderr and not stderr_sample:
                stderr_sample = result.stderr[:2000]
            return SolutionRun(passed=False, per_test=per_test, stderr=stderr_sample)
    return SolutionRun(passed=True, per_test=per_test)


__all__ = ["SolutionRun", "verify_solution"]
