from __future__ import annotations

import pytest
from fusionkit_core.artifacts import LocalArtifactStore
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import (
    CostMetadata,
    EndpointCapabilities,
    FusionConfig,
    ModelEndpoint,
    ProviderKind,
    RunBudget,
)
from fusionkit_core.contracts import FusionRunRequestV1, contract_metadata
from fusionkit_core.fusion import FusionEngine
from fusionkit_core.providers import (
    endpoint_to_contract,
    estimate_cost,
    normalize_usage,
    provider_metadata,
    resolve_api_key,
)
from fusionkit_core.run import FusionRunManager, NativeRunError, RunInspection
from fusionkit_core.run_store import FileSystemRunStore
from fusionkit_core.types import Usage


def test_provider_config_supports_required_families(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-openai-key")
    endpoints = [
        ModelEndpoint(id="openai", provider="openai", model="gpt", base_url="https://api.openai.com"),
        ModelEndpoint(id="anthropic", provider="anthropic", model="claude", base_url="https://api.anthropic.com"),
        ModelEndpoint(id="google", provider="google", model="gemini", base_url="https://generativelanguage.googleapis.com"),
        ModelEndpoint(id="compatible", provider="openai-compatible", model="local", base_url="http://localhost:9000"),
        ModelEndpoint(
            id="mlx",
            provider="mlx-lm",
            model="mlx-model",
            base_url="http://localhost:8101",
            api_key="not-needed",
        ),
        ModelEndpoint(id="custom", provider="custom", model="custom", base_url="http://localhost:9001"),
        ModelEndpoint(
            id="secret",
            provider="openai",
            model="gpt",
            base_url="https://api.openai.com",
            api_key_env="OPENAI_API_KEY",
        ),
    ]
    config = FusionConfig(endpoints=endpoints, default_model="openai")

    assert [endpoint.provider for endpoint in config.endpoints][:6] == [
        "openai",
        "anthropic",
        "google",
        "openai-compatible",
        "mlx-lm",
        "custom",
    ]
    assert resolve_api_key(config.endpoint_for("secret")) == "synthetic-openai-key"


def test_resolve_api_key_raises_when_env_var_missing(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    endpoint = ModelEndpoint(
        id="secret",
        provider="openai",
        model="gpt",
        base_url="https://api.openai.com",
        api_key_env="OPENAI_API_KEY",
    )
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        resolve_api_key(endpoint)


def test_api_compatibility_maps_providers_within_contract_enum() -> None:
    def compatibility(provider: ProviderKind) -> str:
        endpoint = ModelEndpoint(
            id=provider, provider=provider, model="m", base_url="https://example.test"
        )
        return endpoint_to_contract(endpoint).api_compatibility

    assert compatibility("openai") == "openai-chat-completions"
    assert compatibility("openai-compatible") == "openai-chat-completions"
    assert compatibility("mlx-lm") == "mlx-lm-server"
    # The model_endpoint.v1 enum has no native cloud value, so Anthropic and
    # Google map to the generic "custom" wire format.
    assert compatibility("anthropic") == "custom"
    assert compatibility("google") == "custom"


def test_endpoint_metadata_converts_to_contract_capabilities() -> None:
    endpoint = ModelEndpoint(
        id="openai",
        provider="openai",
        model="gpt",
        base_url="https://api.openai.com",
        max_context=128000,
        capabilities=EndpointCapabilities(
            structured_output=True,
            tool_calls=False,
            streaming=None,
        ),
        pricing=CostMetadata(input_per_1m_tokens=0.5, output_per_1m_tokens=1.5),
    )

    record = endpoint_to_contract(endpoint)

    assert record.schema_name == "model_endpoint.v1"
    assert record.endpoint_id == "openai"
    assert record.provider == "openai"
    assert record.capabilities["structured_output"] == "supported"
    assert record.capabilities["tool_calls"] == "unsupported"
    assert record.capabilities["streaming"] == "unknown"


def test_usage_normalization_and_cost_estimation() -> None:
    endpoint = ModelEndpoint(
        id="priced",
        model="priced-model",
        base_url="http://localhost:9000",
        pricing=CostMetadata(input_per_1m_tokens=2.0, output_per_1m_tokens=6.0),
    )
    usage = Usage(prompt_tokens=1_000, completion_tokens=500, total_tokens=1_500)

    normalized = normalize_usage(usage)
    cost = estimate_cost(endpoint, usage)
    metadata = provider_metadata(endpoint, usage)

    assert normalized is not None
    assert normalized.prompt_tokens == 1_000
    assert cost == 0.005
    assert metadata["cost_estimate"] == 0.005
    assert metadata["unknown_cost"] is False


def test_missing_usage_and_cost_are_unknown_not_zero() -> None:
    endpoint = ModelEndpoint(id="unknown", model="unknown", base_url="http://localhost:9000")

    metadata = provider_metadata(endpoint, None)

    assert metadata["cost_estimate"] is None
    assert metadata["unknown_usage"] is True
    assert metadata["unknown_cost"] is True


@pytest.mark.asyncio
async def test_native_run_inspection_exposes_provider_metadata(tmp_path) -> None:
    manager = _manager(
        tmp_path,
        budget=RunBudget(),
        pricing=CostMetadata(input_per_1m_tokens=2.0, output_per_1m_tokens=6.0),
    )

    result = await manager.create_and_run(_request("provider_metadata_run"))

    assert isinstance(result, RunInspection)
    assert result.provider_metadata
    assert result.provider_metadata[0]["provider"] == "openai-compatible"
    assert result.provider_metadata[0]["cost_estimate"] is not None


@pytest.mark.asyncio
async def test_native_run_budget_violation_fails_schema_valid_run(tmp_path) -> None:
    manager = _manager(tmp_path, budget=RunBudget(max_candidates=1))

    result = await manager.create_and_run(
        _request("budget_fail", mode="panel", requested_models=["fast", "writer"])
    )

    assert isinstance(result, RunInspection)
    assert result.state == "failed"
    assert result.terminal_error is not None
    assert result.terminal_error.error_code == "budget_exceeded"
    assert result.terminal_error.terminal_reason == "budget_exceeded:max_candidates"


@pytest.mark.asyncio
async def test_native_run_cost_budget_violation_fails_run(tmp_path) -> None:
    manager = _manager(
        tmp_path,
        budget=RunBudget(max_cost=0.000001),
        pricing=CostMetadata(input_per_1m_tokens=1_000_000, output_per_1m_tokens=1_000_000),
    )

    result = await manager.create_and_run(_request("budget_cost_fail"))

    assert isinstance(result, RunInspection)
    assert result.state == "failed"
    assert result.terminal_error is not None
    assert result.terminal_error.terminal_reason == "budget_exceeded:max_cost"


@pytest.mark.asyncio
async def test_native_run_wall_clock_budget_violation_fails_run(tmp_path) -> None:
    manager = _manager(tmp_path, budget=RunBudget(wall_clock_s=0))

    result = await manager.create_and_run(_request("budget_wall_clock_fail"))

    assert isinstance(result, RunInspection)
    assert result.state == "failed"
    assert result.terminal_error is not None
    assert result.terminal_error.terminal_reason == "budget_exceeded:wall_clock_s"


def test_tool_call_budget_violation_is_rejected(tmp_path) -> None:
    manager = _manager(tmp_path, budget=RunBudget(max_tool_calls=0))
    created = manager.create_run(_request("budget_tool_call_fail"))
    assert created.run_id is not None

    denied = manager.request_tool_action(
        created.run_id,
        trajectory_id="trajectory_a",
        tool_name="read_file",
    )

    assert isinstance(denied, NativeRunError)
    assert denied.terminal_reason == "budget_exceeded:max_tool_calls"


def _manager(
    tmp_path,
    *,
    budget: RunBudget,
    pricing: CostMetadata | None = None,
) -> FusionRunManager:
    endpoint = ModelEndpoint(
        id="fast",
        model="fake-fast",
        base_url="http://localhost:8101",
        pricing=pricing or CostMetadata(),
    )
    writer = ModelEndpoint(id="writer", model="fake-writer", base_url="http://localhost:8102")
    config = FusionConfig(
        endpoints=[endpoint, writer],
        default_model="fast",
        judge_model="fast",
        panel_models=["fast"],
        budget=budget,
    )
    engine = FusionEngine(
        config=config,
        clients={
            "fast": FakeModelClient(
                "fast",
                [
                    "candidate with evidence",
                    '{"consensus":["ok"],"contradictions":[],"unique_insights":[],'
                    '"coverage_gaps":[],"likely_errors":[],"recommended_final_structure":["short"]}',
                    "final answer",
                ],
            ),
            "writer": FakeModelClient("writer", ["writer candidate"]),
        },
    )
    return FusionRunManager(
        engine,
        FileSystemRunStore(tmp_path / "runs"),
        LocalArtifactStore(tmp_path / "runs"),
    )


def _request(
    request_id: str,
    *,
    mode: str = "single",
    requested_models: list[str] | None = None,
) -> FusionRunRequestV1:
    return FusionRunRequestV1.model_validate(
        {
            **contract_metadata("fusion-run-request.v1"),
            "request_id": request_id,
            "mode": mode,
            "messages": [{"role": "user", "content": "hello"}],
            "sampling": {},
            "requested_models": requested_models,
        }
    )
