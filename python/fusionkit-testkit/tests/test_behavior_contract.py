"""Keep the language-neutral expected-behavior contract aligned with the
Python provider matrix. Adding/removing a provider profile cannot silently
leave the executable inventory stale."""

from __future__ import annotations

import json
from pathlib import Path

from fusionkit_testkit.matrix import PROVIDER_PROFILES


def _contract() -> dict:
    root = Path(__file__).resolve().parents[3]
    return json.loads((root / "spec" / "testing" / "expected-behaviors.json").read_text())


def test_provider_axis_equals_the_executable_python_matrix() -> None:
    expected = sorted(_contract()["axes"]["providers"])
    actual = sorted(profile.provider for profile in PROVIDER_PROFILES)
    assert actual == expected


def test_every_provider_profile_declares_wire_and_capability_semantics() -> None:
    for profile in PROVIDER_PROFILES:
        assert profile.dialect
        assert profile.auth_field
        assert profile.auth_value_template
        assert profile.text_finish_reason
        assert profile.tool_finish_reason
        assert profile.quota_category in {
            "quota_exhausted",
            "transient",
        }
