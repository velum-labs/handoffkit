"""Output checkers for stdout-based coding benchmarks.

A single "strip and compare" rule mis-scores many real problems: floats need a
tolerance, some judges are token- rather than line-oriented, and yes/no answers
are case-insensitive. This module provides several checkers and a selector so a
benchmark can match the problem's grading semantics instead of forcing exact
string equality everywhere.
"""

from __future__ import annotations

from typing import Literal, assert_never

CheckerMode = Literal["exact", "token", "float", "case_insensitive"]


def normalize_lines(output: str) -> str:
    return "\n".join(line.rstrip() for line in output.strip("\n").splitlines()).strip()


def exact_check(expected: str, actual: str) -> bool:
    return normalize_lines(expected) == normalize_lines(actual)


def token_check(expected: str, actual: str) -> bool:
    return expected.split() == actual.split()


def case_insensitive_check(expected: str, actual: str) -> bool:
    return normalize_lines(expected).lower() == normalize_lines(actual).lower()


def float_check(expected: str, actual: str, *, tol: float = 1e-6) -> bool:
    expected_tokens = expected.split()
    actual_tokens = actual.split()
    if len(expected_tokens) != len(actual_tokens):
        return False
    for exp, act in zip(expected_tokens, actual_tokens, strict=True):
        exp_num = _as_float(exp)
        act_num = _as_float(act)
        if exp_num is not None and act_num is not None:
            if abs(exp_num - act_num) > tol:
                return False
        elif exp != act:
            return False
    return True


def check_output(
    expected: str,
    actual: str,
    *,
    mode: CheckerMode = "exact",
    float_tol: float = 1e-6,
) -> bool:
    if mode == "exact":
        return exact_check(expected, actual)
    if mode == "token":
        return token_check(expected, actual)
    if mode == "case_insensitive":
        return case_insensitive_check(expected, actual)
    if mode == "float":
        return float_check(expected, actual, tol=float_tol)
    assert_never(mode)


def _as_float(token: str) -> float | None:
    try:
        return float(token)
    except ValueError:
        return None


__all__ = [
    "CheckerMode",
    "case_insensitive_check",
    "check_output",
    "exact_check",
    "float_check",
    "normalize_lines",
    "token_check",
]
