"""Pricing lookup semantics for the generated registry."""

from __future__ import annotations

from fusionkit_core.registry import default_pricing_for


def test_default_pricing_exact_match() -> None:
    pricing = default_pricing_for("gpt-5.5")
    assert pricing is not None
    assert pricing["inputPer1mTokens"] == 1.25


def test_default_pricing_alias_match() -> None:
    pricing = default_pricing_for("gpt-5.5-2026-05")
    assert pricing is not None
    assert pricing["inputPer1mTokens"] == 1.25


def test_default_pricing_unknown_id_not_prefix_matched() -> None:
    assert default_pricing_for("totally-new-model-2027") is None
    assert default_pricing_for("claude-haiku-4-5-unknown-suffix") is None
