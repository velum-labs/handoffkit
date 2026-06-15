from __future__ import annotations


def exact_match(output: str, expected: str | None) -> float | None:
    if expected is None:
        return None
    return float(output.strip().lower() == expected.strip().lower())


def contains_expected(output: str, expected: str | None) -> float | None:
    if expected is None:
        return None
    return float(expected.strip().lower() in output.strip().lower())
