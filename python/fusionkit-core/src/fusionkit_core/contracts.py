from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Annotated, Any, ClassVar, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator

SchemaName: TypeAlias = Literal[
    "model_endpoint.v1",
    "model-call-record.v1",
    "fusion-run-request.v1",
    "fusion-record.v1",
    "judge-synthesis-record.v1",
    "benchmark-task-record.v1",
    "artifact-ref.v1",
    "tool-call-plan.v1",
    "tool-execution-record.v1",
]

ErrorKind: TypeAlias = Literal[
    "none",
    "provider_error",
    "validation_error",
    "timeout",
    "rate_limited",
    "tool_denied",
    "secret_denied",
    "capability_missing",
    "internal_error",
]
Owner: TypeAlias = Literal[
    "fusionkit",
    "handoffkit",
    "cursorkit",
    "mlx-lm",
    "benchmark",
    "external",
]
Status: TypeAlias = Literal[
    "pending",
    "running",
    "succeeded",
    "failed",
    "canceled",
    "requires_action",
    "skipped",
    "unsupported",
]
SideEffects: TypeAlias = Literal[
    "none",
    "read_only",
    "writes_workspace",
    "network",
    "tool_execution",
    "unknown",
]
ArtifactKind: TypeAlias = Literal[
    "patch",
    "log",
    "transcript",
    "metrics",
    "benchmark_task",
    "worktree",
    "receipt",
    "other",
]
CapabilityStatus: TypeAlias = Literal["supported", "unsupported", "degraded", "unknown"]
FusionMode: TypeAlias = Literal["single", "self", "panel", "router"]
ChatRole: TypeAlias = Literal["system", "user", "assistant", "tool"]
ApiCompatibility: TypeAlias = Literal[
    "openai-chat-completions",
    "openai-responses",
    "mlx-lm-server",
    "custom",
]
ToolPolicy: TypeAlias = Literal["disabled", "external_pause", "allowed"]
SynthesisDecision: TypeAlias = Literal[
    "synthesize",
    "select_candidate",
    "repair_required",
    "failed",
]
BenchmarkTaskKind: TypeAlias = Literal["model_fusion", "harness_coding"]
BenchmarkSourceRepo: TypeAlias = Literal["fusionkit", "handoffkit", "cursorkit", "mlx-lm"]
BenchmarkScorerKind: TypeAlias = Literal["exact", "contains", "record_join", "custom"]
RedactionStatus: TypeAlias = Literal["synthetic", "redacted", "raw"]

FusionRunState: TypeAlias = Literal[
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
]

Sha256: TypeAlias = Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
GitSha: TypeAlias = Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]

UNKNOWN_GIT_SHA = "0" * 40
PRODUCER = "fusionkit-core"


class ContractBaseModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        serialize_by_alias=True,
    )


class ContractMetadata(ContractBaseModel):
    schema_name: SchemaName = Field(alias="schema")
    schema_version: Literal["v1"]
    schema_bundle_hash: Sha256
    producer: str = Field(min_length=1)
    producer_version: str = Field(min_length=1)
    producer_git_sha: GitSha
    created_at: datetime


class ContractRecord(ContractMetadata):
    expected_schema: ClassVar[str] = ""

    @model_validator(mode="after")
    def validate_expected_schema(self) -> ContractRecord:
        if self.expected_schema and self.schema_name != self.expected_schema:
            raise ValueError(
                f"Expected schema {self.expected_schema!r}, got {self.schema_name!r}"
            )
        return self


class ContractChatMessage(ContractBaseModel):
    role: ChatRole
    content: str


class ContractUsage(ContractBaseModel):
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ContractError(ContractBaseModel):
    kind: ErrorKind
    message: str | None = None
    retryable: bool | None = None


class ContractSampling(ContractBaseModel):
    temperature: float | None = Field(default=None, ge=0)
    top_p: float | None = Field(default=None, ge=0, le=1)
    max_tokens: int | None = Field(default=None, ge=1)
    seed: int | None = None


class ArtifactRefV1(ContractRecord):
    expected_schema: ClassVar[str] = "artifact-ref.v1"
    artifact_id: str = Field(min_length=1)
    kind: ArtifactKind
    hash: Sha256
    uri: str | None = None
    redaction_status: RedactionStatus | None = None


class ContractArtifactRef(ContractBaseModel):
    artifact_id: str = Field(min_length=1)
    kind: ArtifactKind
    hash: Sha256
    uri: str | None = None
    redaction_status: RedactionStatus | None = None


class ModelEndpointV1(ContractRecord):
    expected_schema: ClassVar[str] = "model_endpoint.v1"
    endpoint_id: str = Field(min_length=1)
    owner: Owner
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    api_compatibility: ApiCompatibility
    capabilities: dict[str, CapabilityStatus]
    status: Status
    base_url: str | None = None
    max_context_tokens: int | None = Field(default=None, ge=1)
    estimated_memory_gb: float | None = Field(default=None, ge=0)
    tags: list[str] | None = None


class ModelCallRecordV1(ContractRecord):
    expected_schema: ClassVar[str] = "model-call-record.v1"
    call_id: str = Field(min_length=1)
    endpoint_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    request_hash: Sha256
    status: Status
    messages: list[ContractChatMessage] = Field(min_length=1)
    side_effects: SideEffects
    started_at: datetime
    provider_request_id: str | None = None
    response_hash: Sha256 | None = None
    finished_at: datetime | None = None
    latency_ms: float | None = Field(default=None, ge=0)
    usage: ContractUsage | None = None
    output_text: str | None = None
    error: ContractError | None = None
    metadata: dict[str, Any] | None = None


class FusionRunRequestV1(ContractRecord):
    expected_schema: ClassVar[str] = "fusion-run-request.v1"
    request_id: str = Field(min_length=1)
    mode: FusionMode
    messages: list[ContractChatMessage] = Field(min_length=1)
    sampling: ContractSampling
    verify: bool
    requested_models: list[str] | None = None
    sample_count: int | None = Field(default=None, ge=1)
    tool_policy: ToolPolicy | None = None
    request_hash: Sha256 | None = None


class FusionRecordV1(ContractRecord):
    expected_schema: ClassVar[str] = "fusion-record.v1"
    run_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    mode: FusionMode
    status: Status
    candidate_ids: list[str]
    model_call_ids: list[str]
    started_at: datetime
    selected_candidate_id: str | None = None
    synthesis_record_id: str | None = None
    final_output: str | None = None
    finished_at: datetime | None = None
    latency_ms: float | None = Field(default=None, ge=0)
    metrics: dict[str, Any] | None = None
    artifacts: list[ContractArtifactRef] | None = None
    error: ContractError | None = None


class JudgeSynthesisRecordV1(ContractRecord):
    expected_schema: ClassVar[str] = "judge-synthesis-record.v1"
    synthesis_id: str = Field(min_length=1)
    input_candidate_ids: list[str] = Field(min_length=1)
    status: Status
    decision: SynthesisDecision
    final_output: str
    judge_model_call_id: str | None = None
    selected_candidate_id: str | None = None
    rationale: str | None = None
    score: float | None = None
    metrics: dict[str, Any] | None = None


class BenchmarkScorer(ContractBaseModel):
    kind: BenchmarkScorerKind
    params: dict[str, Any] | None = None


class BenchmarkTaskRecordV1(ContractRecord):
    expected_schema: ClassVar[str] = "benchmark-task-record.v1"
    task_id: str = Field(min_length=1)
    task_kind: BenchmarkTaskKind
    source_repo: BenchmarkSourceRepo
    source_sha: GitSha
    prompt_hash: Sha256
    setup_hash: Sha256
    expected_evidence: list[str] = Field(min_length=1)
    scorer: BenchmarkScorer
    holdout: bool
    contamination_notes: str
    allowed_tools: list[str]
    prompt: str | None = None


class ToolCallPlanV1(ContractRecord):
    expected_schema: ClassVar[str] = "tool-call-plan.v1"
    plan_id: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    arguments_hash: Sha256
    side_effects: SideEffects
    status: Status


class ToolExecutionRecordV1(ContractRecord):
    expected_schema: ClassVar[str] = "tool-execution-record.v1"
    execution_id: str = Field(min_length=1)
    plan_id: str = Field(min_length=1)
    status: Status
    output_hash: Sha256 | None = None
    error: ContractError | None = None


CONTRACT_MODEL_REGISTRY: dict[SchemaName, type[ContractRecord]] = {
    "model_endpoint.v1": ModelEndpointV1,
    "model-call-record.v1": ModelCallRecordV1,
    "fusion-run-request.v1": FusionRunRequestV1,
    "fusion-record.v1": FusionRecordV1,
    "judge-synthesis-record.v1": JudgeSynthesisRecordV1,
    "benchmark-task-record.v1": BenchmarkTaskRecordV1,
    "artifact-ref.v1": ArtifactRefV1,
    "tool-call-plan.v1": ToolCallPlanV1,
    "tool-execution-record.v1": ToolExecutionRecordV1,
}

FUSION_RUN_STATE_TO_STATUS: dict[FusionRunState, Status] = {
    "queued": "pending",
    "generating": "running",
    "requires_action": "requires_action",
    "judging": "running",
    "synthesizing": "running",
    "verifying": "running",
    "completed": "succeeded",
    "failed": "failed",
    "cancelled": "canceled",
    "expired": "failed",
}


def schema_bundle_hash(schema_dir: Path | None = None) -> str:
    resolved_schema_dir = schema_dir or _default_schema_dir()
    payload = []
    for path in sorted(resolved_schema_dir.glob("*.schema.json")):
        payload.append({"path": path.name, "schema": _load_json(path)})
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def producer() -> str:
    return PRODUCER


def producer_version() -> str:
    try:
        return metadata.version(PRODUCER)
    except metadata.PackageNotFoundError:
        return "0.1.0"


def producer_git_sha(repo_root: Path | None = None) -> str:
    root = repo_root or _default_repo_root()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return UNKNOWN_GIT_SHA

    git_sha = result.stdout.strip()
    if len(git_sha) == 40 and all(character in "0123456789abcdef" for character in git_sha):
        return git_sha
    return UNKNOWN_GIT_SHA


def contract_metadata(
    schema: SchemaName,
    *,
    schema_dir: Path | None = None,
    repo_root: Path | None = None,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    timestamp = created_at or datetime.now(UTC)
    return {
        "schema": schema,
        "schema_version": "v1",
        "schema_bundle_hash": schema_bundle_hash(schema_dir),
        "producer": producer(),
        "producer_version": producer_version(),
        "producer_git_sha": producer_git_sha(repo_root),
        "created_at": timestamp,
    }


def contract_model_for_schema(schema: SchemaName) -> type[ContractRecord]:
    return CONTRACT_MODEL_REGISTRY[schema]


def status_for_run_state(state: FusionRunState) -> Status:
    return FUSION_RUN_STATE_TO_STATUS[state]


def _default_schema_dir() -> Path:
    for parent in Path(__file__).resolve().parents:
        schema_dir = parent / "spec" / "model-fusion-contract" / "schema"
        if schema_dir.exists():
            return schema_dir
    raise FileNotFoundError("Could not locate spec/model-fusion-contract/schema")


def _default_repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    return Path.cwd()


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


__all__ = [
    "ArtifactKind",
    "ArtifactRefV1",
    "BenchmarkScorer",
    "BenchmarkScorerKind",
    "BenchmarkSourceRepo",
    "BenchmarkTaskKind",
    "BenchmarkTaskRecordV1",
    "CapabilityStatus",
    "ChatRole",
    "ContractArtifactRef",
    "ContractChatMessage",
    "ContractError",
    "ContractMetadata",
    "ContractRecord",
    "ContractSampling",
    "ContractUsage",
    "ErrorKind",
    "FUSION_RUN_STATE_TO_STATUS",
    "FusionMode",
    "FusionRecordV1",
    "FusionRunRequestV1",
    "FusionRunState",
    "GitSha",
    "JudgeSynthesisRecordV1",
    "ModelCallRecordV1",
    "ModelEndpointV1",
    "Owner",
    "PRODUCER",
    "SchemaName",
    "Sha256",
    "SideEffects",
    "Status",
    "ToolCallPlanV1",
    "ToolExecutionRecordV1",
    "ToolPolicy",
    "contract_metadata",
    "contract_model_for_schema",
    "producer",
    "producer_git_sha",
    "producer_version",
    "schema_bundle_hash",
    "status_for_run_state",
]
