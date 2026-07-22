"""Streaming tool-call reassembly regression tests.

Guards against the trace_87344373 failure mode: a panel model's large
multi-fragment tool-call arguments were corrupted during streaming reassembly
(fragments dropped when several arrived in one chunk; interleaved parallel
calls misfolded into whichever call happened to be last), producing tool calls
whose argument heads were missing.
"""

from __future__ import annotations

import json

from fusionkit_core.judge import accumulate_tool_call
from fusionkit_core.types import ToolCall


def _fold(deltas: list[ToolCall]) -> list[dict[str, str]]:
    accumulator: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for delta in deltas:
        accumulate_tool_call(accumulator, seen_ids, delta)
    return accumulator


def test_openai_chat_single_call_reassembles_byte_identical() -> None:
    arguments = json.dumps({"patch": "*** Begin Patch\n" + "x = [1, 2, 3]\n" * 40})
    pieces = [arguments[i : i + 7] for i in range(0, len(arguments), 7)]
    deltas = [ToolCall(id="call_1", name="apply_patch", arguments="", index=0)]
    deltas += [ToolCall(id="", name="", arguments=piece, index=0) for piece in pieces]

    folded = _fold(deltas)

    assert len(folded) == 1
    assert folded[0]["id"] == "call_1"
    assert folded[0]["name"] == "apply_patch"
    assert folded[0]["arguments"] == arguments
    assert json.loads(folded[0]["arguments"])  # parses back cleanly


def test_interleaved_parallel_calls_fold_by_index_not_arrival_order() -> None:
    args_a = json.dumps({"cmd": "ls -la src"})
    args_b = json.dumps({"path": "README.md"})
    deltas = [
        ToolCall(id="call_a", name="exec_command", arguments="", index=0),
        ToolCall(id="call_b", name="read_file", arguments="", index=1),
        # Continuation fragments interleave across slots with empty ids.
        ToolCall(id="", name="", arguments=args_a[:8], index=0),
        ToolCall(id="", name="", arguments=args_b[:5], index=1),
        ToolCall(id="", name="", arguments=args_a[8:], index=0),
        ToolCall(id="", name="", arguments=args_b[5:], index=1),
    ]

    folded = _fold(deltas)

    assert [item["id"] for item in folded] == ["call_a", "call_b"]
    assert folded[0]["arguments"] == args_a
    assert folded[1]["arguments"] == args_b


def test_empty_id_continuations_without_index_keep_legacy_folding() -> None:
    # Codex/Responses shape: no index, the opening fragment carries the id and
    # argument text follows on empty-id fragments.
    deltas = [
        ToolCall(id="call_1", name="write_file", arguments=""),
        ToolCall(id="", name="", arguments='{"path": '),
        ToolCall(id="", name="", arguments='"calculator.js"}'),
    ]

    folded = _fold(deltas)

    assert len(folded) == 1
    assert folded[0]["arguments"] == '{"path": "calculator.js"}'


def test_repeated_id_fragments_without_index_append_to_call_in_flight() -> None:
    # Responses-style: every fragment repeats the same non-empty call_id.
    deltas = [
        ToolCall(id="call_9", name="exec_command", arguments='{"cmd": '),
        ToolCall(id="call_9", name="", arguments='"pwd"}'),
    ]

    folded = _fold(deltas)

    assert len(folded) == 1
    assert folded[0]["arguments"] == '{"cmd": "pwd"}'


def test_large_indexed_stream_survives_many_fragments() -> None:
    # The corrupted trace payload was ~614 chars of Python source; make sure a
    # much larger indexed stream reassembles without loss.
    source = "class State:\n    items: dict[str, Any] = field(default_factory=dict)\n" * 30
    arguments = json.dumps({"patch": source})
    deltas = [ToolCall(id="call_big", name="apply_patch", arguments="", index=0)]
    deltas += [
        ToolCall(id="", name="", arguments=arguments[i : i + 13], index=0)
        for i in range(0, len(arguments), 13)
    ]

    folded = _fold(deltas)

    assert folded[0]["arguments"] == arguments
    assert json.loads(folded[0]["arguments"])["patch"] == source
