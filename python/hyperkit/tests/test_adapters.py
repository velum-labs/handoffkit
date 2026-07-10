from __future__ import annotations

from hyperkit.adapters.swebench import SwebenchAdapter
from hyperkit.adapters.terminal_bench import TerminalBenchAdapter


def test_swebench_report_parser() -> None:
    out = SwebenchAdapter().parse_report(
        {"submitted_ids": ["a", "b"], "resolved_ids": ["b"]},
        ["a", "b", "c"],
    )
    assert out == {"a": False, "b": True, "c": False}


def test_terminal_bench_report_parser() -> None:
    out = TerminalBenchAdapter().parse_report(
        {
            "results": [
                {"task_id": "a", "is_resolved": True},
                {"task_id": "b", "is_resolved": False},
            ]
        },
        ["a", "b", "c"],
    )
    assert out == {"a": True, "b": False, "c": False}

