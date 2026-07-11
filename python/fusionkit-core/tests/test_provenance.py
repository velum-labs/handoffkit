"""WS7 real-lite provenance: producer git SHA + version resolution.

Replaces the old hardcoded ``producer_git_sha = "0" * 40`` faked provenance with
a real-lite resolver (build stamp -> checkout git -> ``"unknown"`` sentinel) and
relaxes only the ``producer_git_sha`` field to accept that sentinel.
"""

from __future__ import annotations

import re

import pytest
from fusionkit_core import contracts
from fusionkit_core.contracts import (
    BUILD_GIT_SHA_ENV,
    UNKNOWN_GIT_SHA,
    ContractMetadata,
    ModelCallRecordV1,
    contract_metadata,
    producer_git_sha,
    producer_version,
)
from pydantic import ValidationError

GIT_SHA = re.compile(r"^[a-f0-9]{40}$")


def test_unknown_git_sha_sentinel_is_not_forty_zeros() -> None:
    assert UNKNOWN_GIT_SHA == "unknown"
    assert UNKNOWN_GIT_SHA != "0" * 40


def test_producer_git_sha_resolves_a_real_sha_from_the_checkout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The suite runs from the source checkout, so the git fallback resolves the
    # real producer SHA (no build stamp set).
    monkeypatch.delenv(BUILD_GIT_SHA_ENV, raising=False)
    sha = producer_git_sha()
    assert GIT_SHA.match(sha), f"expected a real 40-hex SHA, got {sha!r}"
    assert sha != "0" * 40


def test_build_stamp_wins_over_the_checkout_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    stamped = "a" * 40
    monkeypatch.setenv(BUILD_GIT_SHA_ENV, stamped)
    assert producer_git_sha() == stamped


def test_sentinel_when_no_stamp_and_not_a_checkout(monkeypatch: pytest.MonkeyPatch) -> None:
    # An installed wheel ships no .git above the package; the resolver must NOT
    # run `git rev-parse` in the cwd (which would stamp the consumer's repo) —
    # it returns the clearly-marked sentinel instead.
    monkeypatch.delenv(BUILD_GIT_SHA_ENV, raising=False)
    monkeypatch.setattr(contracts, "_checkout_root", lambda: None)
    assert producer_git_sha() == UNKNOWN_GIT_SHA


def test_producer_version_is_real(monkeypatch: pytest.MonkeyPatch) -> None:
    # Installed: importlib metadata; source checkout fallback is a real semver.
    assert re.match(r"^\d+\.\d+", producer_version())


def test_contract_metadata_carries_real_lite_provenance() -> None:
    metadata = contract_metadata("model-call-record.v1")
    sha = metadata["producer_git_sha"]
    assert sha != "0" * 40
    assert GIT_SHA.match(sha) or sha == UNKNOWN_GIT_SHA
    assert re.match(r"^\d+\.\d+", metadata["producer_version"])


def test_producer_git_sha_field_accepts_the_sentinel() -> None:
    payload = {
        "schema": "model-call-record.v1",
        "schema_version": "v1",
        "schema_bundle_hash": "sha256:" + "0" * 64,
        "producer": "fusionkit-core",
        "producer_version": "0.1.1",
        "producer_git_sha": UNKNOWN_GIT_SHA,
        "created_at": "2026-06-27T00:00:00Z",
    }
    # The producer_git_sha field accepts the sentinel...
    meta = ContractMetadata.model_validate(payload)
    assert meta.producer_git_sha == "unknown"
    # ...and a real SHA...
    meta_real = ContractMetadata.model_validate({**payload, "producer_git_sha": "a" * 40})
    assert meta_real.producer_git_sha == "a" * 40
    # ...but still rejects an arbitrary non-SHA, non-sentinel value.
    with pytest.raises(ValidationError):
        ContractMetadata.model_validate({**payload, "producer_git_sha": "not-a-sha"})


def test_built_model_call_record_validates_with_sentinel_sha() -> None:
    record = ModelCallRecordV1.model_validate(
        {
            **contract_metadata("model-call-record.v1"),
            "producer_git_sha": UNKNOWN_GIT_SHA,
            "call_id": "call_1",
            "endpoint_id": "ep",
            "model": "m",
            "request_hash": "sha256:" + "0" * 64,
            "status": "succeeded",
            "messages": [{"role": "user", "content": "hi"}],
            "side_effects": "none",
            "started_at": "2026-06-27T00:00:00Z",
        }
    )
    assert record.producer_git_sha == "unknown"
