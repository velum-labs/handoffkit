from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fusionkit_core.contracts import (
    CONTRACT_MODEL_REGISTRY,
    SCHEMA_BUNDLE_HASH,
    ArtifactRefV1,
    BenchmarkTaskRecordV1,
    EnsembleReceiptV1,
    FusionRecordV1,
    FusionRunRequestV1,
    FusionRunState,
    HarnessCandidateRecordV1,
    HarnessRunRequestV1,
    HarnessRunResultV1,
    JudgeSynthesisRecordV1,
    ModelCallRecordV1,
    ModelEndpointV1,
    SchemaName,
    ToolCallPlanV1,
    ToolExecutionRecordV1,
    TrajectoryV1,
    contract_metadata,
    producer,
    schema_bundle_hash,
    status_for_run_state,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = REPO_ROOT / "spec" / "model-fusion-contract" / "fixture"
SCHEMA_ROOT = REPO_ROOT / "spec" / "model-fusion-contract" / "schema"

FUSIONKIT_CONTRACT_SCHEMAS: dict[SchemaName, type] = {
    "model_endpoint.v1": ModelEndpointV1,
    "model-call-record.v1": ModelCallRecordV1,
    "fusion-run-request.v1": FusionRunRequestV1,
    "fusion-record.v1": FusionRecordV1,
    "harness-run-request.v1": HarnessRunRequestV1,
    "harness-run-result.v1": HarnessRunResultV1,
    "harness-candidate-record.v1": HarnessCandidateRecordV1,
    "trajectory.v1": TrajectoryV1,
    "judge-synthesis-record.v1": JudgeSynthesisRecordV1,
    "benchmark-task-record.v1": BenchmarkTaskRecordV1,
    "artifact-ref.v1": ArtifactRefV1,
    "tool-call-plan.v1": ToolCallPlanV1,
    "tool-execution-record.v1": ToolExecutionRecordV1,
    "ensemble-receipt.v1": EnsembleReceiptV1,
}


def test_fusionkit_contract_fixtures_validate_through_pydantic_models() -> None:
    expected_bundle_hash = schema_bundle_hash(SCHEMA_ROOT)

    for schema_name, model_class in FUSIONKIT_CONTRACT_SCHEMAS.items():
        for fixture_name in ("minimal.json", "realistic.json"):
            fixture = _load_fixture(schema_name, fixture_name)

            record = model_class.model_validate(fixture)
            dumped = record.model_dump(mode="json", exclude_none=True)

            assert fixture["schema"] == schema_name
            assert dumped["schema"] == schema_name
            assert dumped["schema_bundle_hash"] == expected_bundle_hash
            assert model_class.model_validate(dumped).model_dump(
                mode="json",
                exclude_none=True,
            ) == dumped


def test_pinned_schema_bundle_hash_matches_canonical_schema() -> None:
    # The installed wheel cannot locate spec/ on disk and falls back to the
    # pinned SCHEMA_BUNDLE_HASH; this guards it against drifting from the source.
    assert schema_bundle_hash(SCHEMA_ROOT) == SCHEMA_BUNDLE_HASH


def test_schema_bundle_hash_falls_back_to_pinned_constant_without_schema_dir(
    monkeypatch,
) -> None:
    # Simulate an installed wheel where the canonical schema dir is absent: the
    # helper must still return the frozen hash instead of raising (the bug that
    # 500'd `/v1/fusion/trajectory:step` under `uvx fusionkit`).
    monkeypatch.setattr("fusionkit_core.contracts._find_schema_dir", lambda: None)
    assert schema_bundle_hash() == SCHEMA_BUNDLE_HASH
    assert contract_metadata("trajectory.v1")["schema_bundle_hash"] == SCHEMA_BUNDLE_HASH


def test_contract_model_registry_covers_downstream_fusionkit_tickets() -> None:
    assert CONTRACT_MODEL_REGISTRY == FUSIONKIT_CONTRACT_SCHEMAS


def test_contract_model_registry_entries_are_backed_by_origin_schemas() -> None:
    schema_titles = _schema_titles()

    assert set(CONTRACT_MODEL_REGISTRY).issubset(schema_titles)
    assert {
        "harness-run-result.v1",
        "harness-candidate-record.v1",
        "ensemble-receipt.v1",
    }.issubset(CONTRACT_MODEL_REGISTRY)


def test_contract_metadata_helpers_match_fixture_contract() -> None:
    metadata = contract_metadata(
        "fusion-record.v1",
        schema_dir=SCHEMA_ROOT,
        repo_root=REPO_ROOT,
    )

    assert metadata["schema"] == "fusion-record.v1"
    assert metadata["schema_version"] == "v1"
    assert metadata["schema_bundle_hash"] == schema_bundle_hash(SCHEMA_ROOT)
    assert metadata["producer"] == producer()
    assert FusionRecordV1.model_validate(
        {
            **metadata,
            "run_id": "fusion_run_helper_001",
            "request_id": "fusion_req_helper_001",
            "mode": "single",
            "status": "succeeded",
            "trajectory_ids": [],
            "model_call_ids": [],
            "started_at": metadata["created_at"],
        }
    )


def test_fusion_run_states_map_to_schema_valid_statuses() -> None:
    states: tuple[FusionRunState, ...] = (
        "queued",
        "generating",
        "requires_action",
        "judging",
        "synthesizing",
        "verifying",
        "completed",
        "failed",
        "cancelled",
        "expired",
    )

    assert [status_for_run_state(state) for state in states] == [
        "pending",
        "running",
        "requires_action",
        "running",
        "running",
        "running",
        "succeeded",
        "failed",
        "canceled",
        "failed",
    ]


def test_downstream_readiness_fields_are_typed() -> None:
    model_call = ModelCallRecordV1.model_validate(
        _load_fixture("model-call-record.v1", "realistic.json")
    )
    fusion_record = FusionRecordV1.model_validate(
        _load_fixture("fusion-record.v1", "realistic.json")
    )
    tool_plan = ToolCallPlanV1.model_validate(
        _load_fixture("tool-call-plan.v1", "realistic.json")
    )
    synthesis_record = JudgeSynthesisRecordV1.model_validate(
        _load_fixture("judge-synthesis-record.v1", "realistic.json")
    )
    harness_result = HarnessRunResultV1.model_validate(
        _load_fixture("harness-run-result.v1", "realistic.json")
    )
    harness_candidate = HarnessCandidateRecordV1.model_validate(
        _load_fixture("harness-candidate-record.v1", "realistic.json")
    )
    receipt = EnsembleReceiptV1.model_validate(
        _load_fixture("ensemble-receipt.v1", "realistic.json")
    )
    benchmark_task = BenchmarkTaskRecordV1.model_validate(
        _load_fixture("benchmark-task-record.v1", "realistic.json")
    )
    endpoint = ModelEndpointV1.model_validate(_load_fixture("model_endpoint.v1", "realistic.json"))

    assert model_call.call_id == "call_panel_fast_001"
    assert model_call.usage is not None
    assert fusion_record.run_id == "fusion_run_panel_001"
    assert fusion_record.artifacts is not None
    assert tool_plan.side_effects == "read_only"
    assert synthesis_record.synthesis_id == "synthesis_panel_001"
    assert harness_result.harness_kind == "cursor"
    assert harness_candidate.model_call_id == "call_panel_fast_001"
    assert receipt.run_id == "harness_result_cursor_001"
    assert benchmark_task.scorer.kind == "record_join"
    assert endpoint.capabilities["tool_calls"] == "unsupported"


def _load_fixture(schema_name: SchemaName, fixture_name: str) -> dict[str, Any]:
    with (FIXTURE_ROOT / schema_name / fixture_name).open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise TypeError(f"Fixture {schema_name}/{fixture_name} must be a JSON object")
    return data


def _schema_titles() -> set[str]:
    titles = set()
    for schema_path in SCHEMA_ROOT.glob("*.schema.json"):
        with schema_path.open(encoding="utf-8") as handle:
            schema = json.load(handle)
        title = schema.get("title")
        if title != "Model Fusion Contract Common Definitions":
            titles.add(title)
    return titles
