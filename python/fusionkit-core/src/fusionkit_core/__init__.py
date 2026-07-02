"""Public API for the FusionKit Python engine.

The package re-exports the configuration models, provider clients, fusion engine,
judge synthesizer, run manager, contract models, artifact helpers, trace helpers,
and trajectory producers used by the Python server, CLI, benchmarks, and tests.
Keep this module documented because generated API docs read this docstring and
the `__all__` list as the supported Python surface.

Re-exports are resolved lazily (PEP 562): importing any single submodule (for
example ``fusionkit_core.config``) must not pay for the provider SDK stack that
``fusionkit_core.clients`` drags in. This keeps CLI startup (``fusionkit
--version``, ``fusionkit prompts dump``) fast while ``from fusionkit_core
import X`` keeps working unchanged for every name in ``__all__``.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fusionkit_core.artifacts import LocalArtifactStore, hash_bytes, hash_text
    from fusionkit_core.clients import (
        AnthropicModelClient,
        CodexResponsesClient,
        FakeModelClient,
        GoogleModelClient,
        LocalModelClient,
        OpenAICompatibleClient,
        ProviderCallError,
        ProviderErrorCategory,
        build_client,
        build_clients,
        classify_provider_error,
    )
    from fusionkit_core.config import (
        CostMetadata,
        EndpointAuth,
        EndpointCapabilities,
        FusionConfig,
        FusionMode,
        ModelEndpoint,
        ProviderKind,
        RunBudget,
        SamplingConfig,
        SubscriptionAuthMode,
    )
    from fusionkit_core.contracts import (
        ArtifactRefV1,
        BenchmarkTaskRecordV1,
        ContractMetadata,
        ContractRecord,
        EnsembleReceiptV1,
        FusionRecordV1,
        FusionRunRequestV1,
        FusionRunState,
        HarnessCandidateRecordV1,
        HarnessRunResultV1,
        ModelCallRecordV1,
        ModelEndpointV1,
        ToolCallPlanV1,
        ToolExecutionRecordV1,
        TrajectoryV1,
        contract_metadata,
        contract_model_for_schema,
        producer,
        producer_git_sha,
        producer_version,
        schema_bundle_hash,
        status_for_run_state,
    )
    from fusionkit_core.credentials import (
        SubscriptionAuthError,
        SubscriptionStatus,
        SubscriptionToken,
        load_claude_code_credentials,
        load_codex_credentials,
        resolve_credential,
        subscription_status,
    )
    from fusionkit_core.fusion import FusionEngine
    from fusionkit_core.judge import FuseResult, JudgeSynthesizer
    from fusionkit_core.kernel import FusionKernel
    from fusionkit_core.producers import (
        AgentTrajectoryProducer,
        ChatTrajectoryProducer,
        ExternalTrajectoryProducer,
        ToolExecutor,
        TrajectoryProducer,
        trajectory_from_contract,
        trajectory_from_response,
        trajectory_to_contract,
    )
    from fusionkit_core.providers import (
        endpoint_to_contract,
        estimate_cost,
        normalize_usage,
        provider_metadata,
        resolve_api_key,
    )
    from fusionkit_core.router import HeuristicRouter
    from fusionkit_core.run import (
        CreateRunResult,
        FusionRunEvent,
        FusionRunManager,
        IdempotencyRecord,
        NativeRunError,
        RunEventPage,
        RunInspection,
        RunStateSummary,
        ToolExecutionMode,
        ToolExecutionPolicy,
        ToolPausePlaceholder,
        ToolResultSubmission,
        TrajectoryInspection,
        canonical_json,
        hash_json,
        make_id,
    )
    from fusionkit_core.run_store import FileSystemRunStore
    from fusionkit_core.trace import (
        TRACE_ID_HEADER,
        TRACE_PARENT_SPAN_HEADER,
        TRACE_SPAN_HEADER,
        TRACE_TRAJECTORY_HEADER,
        TraceEmitter,
        ambient_trace_id,
        emit,
        get_emitter,
        new_span_id,
        new_trace_id,
    )
    from fusionkit_core.types import (
        ChatMessage,
        ModelResponse,
        StreamChunk,
        ToolCall,
        Trajectory,
        Usage,
    )

# Which submodule provides each re-exported name (the runtime counterpart of
# the TYPE_CHECKING block above; keep the two in sync).
_EXPORTS_BY_MODULE: dict[str, tuple[str, ...]] = {
    "artifacts": ("LocalArtifactStore", "hash_bytes", "hash_text"),
    "clients": (
        "AnthropicModelClient",
        "CodexResponsesClient",
        "FakeModelClient",
        "GoogleModelClient",
        "LocalModelClient",
        "OpenAICompatibleClient",
        "ProviderCallError",
        "ProviderErrorCategory",
        "build_client",
        "build_clients",
        "classify_provider_error",
    ),
    "config": (
        "CostMetadata",
        "EndpointAuth",
        "EndpointCapabilities",
        "FusionConfig",
        "FusionMode",
        "ModelEndpoint",
        "ProviderKind",
        "RunBudget",
        "SamplingConfig",
        "SubscriptionAuthMode",
    ),
    "contracts": (
        "ArtifactRefV1",
        "BenchmarkTaskRecordV1",
        "ContractMetadata",
        "ContractRecord",
        "EnsembleReceiptV1",
        "FusionRecordV1",
        "FusionRunRequestV1",
        "FusionRunState",
        "HarnessCandidateRecordV1",
        "HarnessRunResultV1",
        "ModelCallRecordV1",
        "ModelEndpointV1",
        "ToolCallPlanV1",
        "ToolExecutionRecordV1",
        "TrajectoryV1",
        "contract_metadata",
        "contract_model_for_schema",
        "producer",
        "producer_git_sha",
        "producer_version",
        "schema_bundle_hash",
        "status_for_run_state",
    ),
    "credentials": (
        "SubscriptionAuthError",
        "SubscriptionStatus",
        "SubscriptionToken",
        "load_claude_code_credentials",
        "load_codex_credentials",
        "resolve_credential",
        "subscription_status",
    ),
    "fusion": ("FusionEngine",),
    "judge": ("FuseResult", "JudgeSynthesizer"),
    "kernel": ("FusionKernel",),
    "producers": (
        "AgentTrajectoryProducer",
        "ChatTrajectoryProducer",
        "ExternalTrajectoryProducer",
        "ToolExecutor",
        "TrajectoryProducer",
        "trajectory_from_contract",
        "trajectory_from_response",
        "trajectory_to_contract",
    ),
    "providers": (
        "endpoint_to_contract",
        "estimate_cost",
        "normalize_usage",
        "provider_metadata",
        "resolve_api_key",
    ),
    "router": ("HeuristicRouter",),
    "run": (
        "CreateRunResult",
        "FusionRunEvent",
        "FusionRunManager",
        "IdempotencyRecord",
        "NativeRunError",
        "RunEventPage",
        "RunInspection",
        "RunStateSummary",
        "ToolExecutionMode",
        "ToolExecutionPolicy",
        "ToolPausePlaceholder",
        "ToolResultSubmission",
        "TrajectoryInspection",
        "canonical_json",
        "hash_json",
        "make_id",
    ),
    "run_store": ("FileSystemRunStore",),
    "trace": (
        "TRACE_ID_HEADER",
        "TRACE_PARENT_SPAN_HEADER",
        "TRACE_SPAN_HEADER",
        "TRACE_TRAJECTORY_HEADER",
        "TraceEmitter",
        "ambient_trace_id",
        "emit",
        "get_emitter",
        "new_span_id",
        "new_trace_id",
    ),
    "types": (
        "ChatMessage",
        "ModelResponse",
        "StreamChunk",
        "ToolCall",
        "Trajectory",
        "Usage",
    ),
}

_MODULE_BY_EXPORT: dict[str, str] = {
    name: module for module, names in _EXPORTS_BY_MODULE.items() for name in names
}

__all__ = [
    "TRACE_ID_HEADER",
    "TRACE_PARENT_SPAN_HEADER",
    "TRACE_SPAN_HEADER",
    "TRACE_TRAJECTORY_HEADER",
    "AgentTrajectoryProducer",
    "AnthropicModelClient",
    "ArtifactRefV1",
    "BenchmarkTaskRecordV1",
    "ChatMessage",
    "ChatTrajectoryProducer",
    "CodexResponsesClient",
    "ContractMetadata",
    "ContractRecord",
    "CostMetadata",
    "CreateRunResult",
    "EndpointAuth",
    "EndpointCapabilities",
    "EnsembleReceiptV1",
    "ExternalTrajectoryProducer",
    "FakeModelClient",
    "FileSystemRunStore",
    "FuseResult",
    "FusionConfig",
    "FusionEngine",
    "FusionKernel",
    "FusionMode",
    "FusionRecordV1",
    "FusionRunEvent",
    "FusionRunManager",
    "FusionRunRequestV1",
    "FusionRunState",
    "GoogleModelClient",
    "HarnessCandidateRecordV1",
    "HarnessRunResultV1",
    "HeuristicRouter",
    "IdempotencyRecord",
    "JudgeSynthesizer",
    "LocalArtifactStore",
    "LocalModelClient",
    "ModelCallRecordV1",
    "ModelEndpoint",
    "ModelEndpointV1",
    "ModelResponse",
    "NativeRunError",
    "OpenAICompatibleClient",
    "ProviderCallError",
    "ProviderErrorCategory",
    "ProviderKind",
    "RunBudget",
    "RunEventPage",
    "RunInspection",
    "RunStateSummary",
    "SamplingConfig",
    "StreamChunk",
    "SubscriptionAuthError",
    "SubscriptionAuthMode",
    "SubscriptionStatus",
    "SubscriptionToken",
    "ToolCall",
    "ToolCallPlanV1",
    "ToolExecutionMode",
    "ToolExecutionPolicy",
    "ToolExecutionRecordV1",
    "ToolExecutor",
    "ToolPausePlaceholder",
    "ToolResultSubmission",
    "Trajectory",
    "TrajectoryInspection",
    "TrajectoryProducer",
    "TrajectoryV1",
    "TraceEmitter",
    "Usage",
    "ambient_trace_id",
    "build_client",
    "build_clients",
    "canonical_json",
    "classify_provider_error",
    "contract_metadata",
    "contract_model_for_schema",
    "emit",
    "endpoint_to_contract",
    "estimate_cost",
    "get_emitter",
    "hash_bytes",
    "hash_json",
    "hash_text",
    "load_claude_code_credentials",
    "load_codex_credentials",
    "make_id",
    "new_span_id",
    "new_trace_id",
    "normalize_usage",
    "producer",
    "producer_git_sha",
    "producer_version",
    "provider_metadata",
    "resolve_api_key",
    "resolve_credential",
    "schema_bundle_hash",
    "status_for_run_state",
    "subscription_status",
    "trajectory_from_contract",
    "trajectory_from_response",
    "trajectory_to_contract",
]

# Keep the static export list and the lazy-resolution map in lockstep.
assert set(__all__) == set(_MODULE_BY_EXPORT), "__all__ drifted from _EXPORTS_BY_MODULE"


def __getattr__(name: str) -> object:
    """Resolve a re-exported name (or submodule) on first access."""
    module_name = _MODULE_BY_EXPORT.get(name)
    if module_name is not None:
        value: object = getattr(importlib.import_module(f"fusionkit_core.{module_name}"), name)
    else:
        try:
            value = importlib.import_module(f"fusionkit_core.{name}")
        except ModuleNotFoundError:
            raise AttributeError(f"module 'fusionkit_core' has no attribute {name!r}") from None
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
