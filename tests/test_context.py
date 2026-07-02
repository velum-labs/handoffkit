"""Unit tests for the deterministic context budgeter (fusionkit_core.context)."""

from __future__ import annotations

from fusionkit_core.config import ContextPolicy, SamplingConfig
from fusionkit_core.context import (
    ContextBudget,
    estimate_messages_tokens,
    estimate_tokens,
    pack_trajectories,
)
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.types import ChatMessage, Trajectory


def _trajectory(
    trajectory_id: str,
    *,
    item_count: int,
    status: str = "succeeded",
    text_size: int = 400,
) -> Trajectory:
    items = [
        TrajectoryItem(
            index=index,
            type="function_call_output",
            text=f"item {index}: " + "x" * text_size,
            call_id=f"call_{index}",
        )
        for index in range(item_count)
    ]
    return Trajectory(
        id=trajectory_id,
        model_id=f"model_{trajectory_id}",
        content=f"final answer of {trajectory_id}",
        items=items,
        status=status,  # type: ignore[arg-type]
    )


# --- estimation -------------------------------------------------------------


def test_estimate_tokens_is_chars_over_four_rounded_up() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abc") == 1
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2
    assert estimate_tokens("x" * 400) == 100


def test_estimate_messages_tokens_counts_every_message() -> None:
    messages = [
        ChatMessage(role="user", content="x" * 40),
        ChatMessage(role="assistant", content="y" * 40),
    ]
    # 10 tokens of content per message plus a small per-message overhead.
    assert estimate_messages_tokens(messages) == 2 * (10 + 4)


def test_context_budget_math_and_default_fallback() -> None:
    policy = ContextPolicy(default_max_context=10_000, safety_margin_tokens=500)
    sampling = SamplingConfig(max_tokens=1_000)

    declared = ContextBudget.for_model(50_000, sampling, policy)
    assert declared.prompt_tokens == 50_000 - 1_000 - 500
    assert declared.evidence_tokens(2_000) == declared.prompt_tokens - 2_000

    undeclared = ContextBudget.for_model(None, sampling, policy)
    assert undeclared.max_context == 10_000
    assert undeclared.prompt_tokens == 10_000 - 1_000 - 500
    # The budget never goes negative.
    assert undeclared.evidence_tokens(10**6) == 0


# --- packing ----------------------------------------------------------------


def test_pack_is_a_noop_under_budget() -> None:
    trajectories = [_trajectory("a", item_count=3), _trajectory("b", item_count=3)]
    packed, report = pack_trajectories(trajectories, 10**6)

    assert packed == trajectories
    assert report.changed is False
    assert report.estimated_tokens_after == report.estimated_tokens_before


def test_pack_elides_middle_items_keeping_head_and_tail() -> None:
    policy = ContextPolicy(keep_head_items=2, keep_tail_items=3)
    trajectory = _trajectory("a", item_count=40)
    original_cost = estimate_tokens(
        "".join(item.text or "" for item in trajectory.items)
    )

    packed, report = pack_trajectories([trajectory], original_cost // 2, policy=policy)

    assert len(packed) == 1
    items = packed[0].items
    # head(2) + marker + tail(3)
    assert len(items) == 6
    assert [item.text for item in items[:2]] == [
        trajectory.items[0].text,
        trajectory.items[1].text,
    ]
    assert [item.text for item in items[-3:]] == [
        trajectory.items[37].text,
        trajectory.items[38].text,
        trajectory.items[39].text,
    ]
    marker = items[2]
    assert marker.type == "message"
    assert marker.text is not None and "35 intermediate items elided" in marker.text
    # The final output is untouched.
    assert packed[0].content == trajectory.content
    assert report.changed is True
    assert report.trajectories[0].original_items == 40
    assert report.trajectories[0].kept_items == 6
    assert report.estimated_tokens_after < report.estimated_tokens_before


def test_pack_strips_items_entirely_when_elision_is_not_enough() -> None:
    policy = ContextPolicy(keep_head_items=2, keep_tail_items=2)
    trajectories = [_trajectory("a", item_count=30), _trajectory("b", item_count=30)]

    # A budget so small that even head+tail does not fit forces tier 2.
    packed, report = pack_trajectories(trajectories, 60, policy=policy)

    assert len(packed) == 2
    assert all(len(trajectory.items) == 0 for trajectory in packed)
    # Final outputs always survive tier 2.
    assert [trajectory.content for trajectory in packed] == [
        "final answer of a",
        "final answer of b",
    ]
    assert report.changed is True


def test_pack_drops_failed_trajectories_before_succeeded_ones() -> None:
    succeeded = _trajectory("good", item_count=10)
    failed = _trajectory("bad", item_count=10, status="failed")

    # Budget fits roughly one final output: tier 3 must drop the failed one.
    packed, report = pack_trajectories([succeeded, failed], 12)

    assert [trajectory.id for trajectory in packed] == ["good"]
    by_id = {pack.trajectory_id: pack for pack in report.trajectories}
    assert by_id["bad"].dropped is True
    assert by_id["good"].dropped is False


def test_pack_never_drops_the_last_survivor() -> None:
    only_failed = [
        _trajectory("f1", item_count=5, status="failed"),
        _trajectory("f2", item_count=5, status="failed"),
    ]

    packed, _report = pack_trajectories(only_failed, 1)

    # Even an impossible budget keeps one candidate answer.
    assert len(packed) >= 1


def test_pack_is_deterministic() -> None:
    trajectories = [
        _trajectory("a", item_count=25),
        _trajectory("b", item_count=40),
        _trajectory("c", item_count=10, status="failed"),
    ]
    first_packed, first_report = pack_trajectories(trajectories, 900)
    second_packed, second_report = pack_trajectories(trajectories, 900)

    assert first_packed == second_packed
    assert first_report == second_report


def test_pack_report_metrics_shape() -> None:
    trajectory = _trajectory("a", item_count=40)
    _packed, report = pack_trajectories([trajectory], 100)

    metrics = report.to_metrics()
    assert metrics["budget_tokens"] == 100
    assert isinstance(metrics["estimated_tokens_before"], int)
    assert isinstance(metrics["estimated_tokens_after"], int)
    trajectories_metric = metrics["trajectories"]
    assert isinstance(trajectories_metric, list)
    assert trajectories_metric[0]["trajectory_id"] == "a"
