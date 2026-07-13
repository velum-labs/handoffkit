from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from hyperkit.adapters.livecodebench import (
    LivecodebenchAdapter,
    _Client,
    _Sandbox,
    decode_tests,
    extract_code,
    run_tests,
)
from hyperkit.core.models import SUTTarget


def test_extract_code_prefers_python_fence() -> None:
    text = "Here you go:\n```python\nprint(1)\n```\ntrailing"
    assert extract_code(text) == "print(1)"


def test_extract_code_falls_back_to_any_fence_and_heuristics() -> None:
    assert extract_code("```\nprint(2)\n```") == "print(2)"
    assert extract_code("Some prose\nimport sys\nprint(3)") == "import sys\nprint(3)"
    assert extract_code("") == ""


def test_decode_tests_splits_public_private() -> None:
    row = {
        "public_test_cases": json.dumps(
            [{"input": "1\n", "output": "2\n", "testtype": "stdin"}]
        ),
        "private_test_cases": json.dumps(
            [
                {"input": "3\n", "output": "4\n", "testtype": "stdin"},
                {"input": "x", "output": "y", "testtype": "functional"},
            ]
        ),
    }
    public, private = decode_tests(row)
    assert len(public) == 1 and len(private) == 1
    assert private[0]["input"] == "3\n"


def test_decode_tests_private_falls_back_to_public() -> None:
    row = {
        "public_test_cases": json.dumps(
            [{"input": "1\n", "output": "2\n", "testtype": "stdin"}]
        ),
        "private_test_cases": "",
    }
    public, private = decode_tests(row)
    assert private == public


def test_run_tests_executes_and_normalizes() -> None:
    sandbox = _Sandbox()
    code = "import sys\nprint(int(sys.stdin.read()) * 2)"
    tests = [
        {"input": "2\n", "output": "4\n"},
        {"input": "5\n", "output": "10  \n"},  # trailing spaces normalize away
    ]
    result = run_tests(sandbox, code, tests, timeout_s=10.0)
    assert result["all_passed"] is True and result["passed"] == 2


def test_run_tests_reports_first_failure() -> None:
    sandbox = _Sandbox()
    result = run_tests(
        sandbox,
        "print('wrong')",
        [{"input": "", "output": "right\n"}],
        timeout_s=10.0,
    )
    assert result["all_passed"] is False
    assert result["failure"]["actual"].strip() == "wrong"


class _Response:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def test_client_retries_malformed_provider_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bodies = iter(
        [
            b"  \n",
            json.dumps(
                {
                    "choices": [
                        {
                            "message": {"content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "cost": 0.001,
                    },
                }
            ).encode(),
        ]
    )
    calls = 0

    def urlopen(*_: object, **__: object) -> _Response:
        nonlocal calls
        calls += 1
        return _Response(next(bodies))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr("hyperkit.adapters.livecodebench.time.sleep", lambda _: None)

    result = _Client("https://provider.example/v1", "key").complete(
        "model",
        "prompt",
        temperature=0.2,
        max_tokens=16,
        attempts=2,
    )

    assert calls == 2
    assert result["text"] == "ok"
    assert result["cost_usd"] == 0.001


PROBLEM = {
    "question_id": "q1",
    "question_content": "Double the input integer.",
    "difficulty": "medium",
    "contest_date": "2024-09-01",
    "public_test_cases": json.dumps([{"input": "2\n", "output": "4\n", "testtype": "stdin"}]),
    "private_test_cases": json.dumps(
        [
            {"input": "10\n", "output": "20\n", "testtype": "stdin"},
            {"input": "7\n", "output": "14\n", "testtype": "stdin"},
        ]
    ),
}

GOOD = "```python\nimport sys\nprint(int(sys.stdin.read())*2)\n```"
BAD = "```python\nprint('nope')\n```"


@pytest.fixture()
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (tmp_path / "q1.json").write_text(json.dumps(PROBLEM))
    monkeypatch.setenv("HYPERKIT_LCB_DIR", str(tmp_path))
    return tmp_path


def _patch_completions(monkeypatch: pytest.MonkeyPatch, responses: list[str]) -> list[dict]:
    calls: list[dict] = []

    def fake_complete(self: _Client, model: str, prompt: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"model": model, "prompt": prompt, **kwargs})
        text = responses[min(len(calls) - 1, len(responses) - 1)]
        return {
            "text": text,
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "cost_usd": 0.001,
            "finish_reason": "stop",
        }

    monkeypatch.setattr(_Client, "complete", fake_complete)
    return calls


def test_selection_first_grades_sample_zero(
    store: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_completions(monkeypatch, [GOOD])
    raw = LivecodebenchAdapter().run_instance(
        "q1",
        SUTTarget(base_url="http://local/v1", model="m"),
        store,
        {"selection": "first"},
    )
    assert raw["resolved"] is True
    assert raw["selected_index"] == 0
    assert raw["cost_usd"] == pytest.approx(0.001)


def test_public_exec_selects_passing_sample(
    store: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_completions(monkeypatch, [BAD, GOOD, BAD])
    raw = LivecodebenchAdapter().run_instance(
        "q1",
        SUTTarget(base_url="http://local/v1", model="m"),
        store,
        {"selection": "public-exec", "n_samples": 3, "temps": [0.2, 0.6, 0.9]},
    )
    assert raw["selected_index"] == 1
    assert raw["resolved"] is True
    assert raw["oracle_private"] is True
    assert len(raw["samples"]) == 3
    assert raw["cost_usd"] == pytest.approx(0.003)


def test_public_exec_repair_fixes_failing_winner(
    store: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _patch_completions(monkeypatch, [BAD, GOOD])
    raw = LivecodebenchAdapter().run_instance(
        "q1",
        SUTTarget(base_url="http://local/v1", model="m"),
        store,
        {"selection": "public-exec-repair", "n_samples": 1},
    )
    assert raw["repair_used"] is True
    assert raw["resolved"] is True
    assert raw["selected_index"] == 1  # the repaired candidate
    assert "failed a sample test" in calls[1]["prompt"]


def test_first_selection_never_repairs_or_extra_samples(
    store: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _patch_completions(monkeypatch, [BAD])
    raw = LivecodebenchAdapter().run_instance(
        "q1",
        SUTTarget(base_url="http://local/v1", model="m"),
        store,
        {},
    )
    assert raw["resolved"] is False
    assert raw["repair_used"] is False
    assert len(calls) == 1


def test_parse_report_maps_outcomes() -> None:
    out = LivecodebenchAdapter().parse_report(
        {"outcomes": {"a": True, "b": False}}, ["a", "b", "c"]
    )
    assert out == {"a": True, "b": False, "c": False}
