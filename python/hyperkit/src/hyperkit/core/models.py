"""Normalized data models for the sweep: specs, cells, shards, results, lock.

These are the *materialized* artifacts the platform stores and reasons about.
They are deliberately free of any system-under-test semantics: a ``TopologySpec``
is opaque payload + a hash, so hyperkit can schedule and dedupe fusion, solo, or
any other SUT identically.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, model_validator

from hyperkit.core.ids import hash_obj, spec_hash


def _utcnow() -> str:
    return datetime.now(UTC).isoformat()


class ResourceProfile(BaseModel):
    """What one shard needs from a host; drives Batch memory reservation.

    The structural fix for the OOM problems: the compute backend reserves this
    much and never overcommits, instead of hand-tuned worker caps.
    """

    vcpu: float = 1.0
    memory_gb: float = 6.0
    needs_docker: bool = True
    wall_clock_s: int = 3600


class TopologySpec(BaseModel):
    """Opaque, hashable description of a system under test.

    hyperkit does not interpret ``kind``/``params`` -- a SUT plugin does. Two
    families in practice: ``solo-model`` and ``fusionkit-serve`` (whose params
    carry a fusion topology). The ``hash`` is a first-class cell coordinate.
    """

    kind: str
    params: dict[str, Any] = Field(default_factory=dict)

    @property
    def hash(self) -> str:
        return spec_hash({"kind": self.kind, "params": self.params})


class SUTTarget(BaseModel):
    """The OpenAI-compatible endpoint a benchmark scaffold should invoke."""

    base_url: str
    model: str
    provider_prefix: str = "openai"

    @property
    def scaffold_model(self) -> str:
        return f"{self.provider_prefix}/{self.model}"


class Cell(BaseModel):
    """One hypergrid point: a SUT x benchmark x instance-set, with a budget.

    Expands to one shard per instance. Cells are produced by an Experiment's
    ``cells()`` and frozen into the lock at plan time; runners never re-run the
    experiment code that produced them.
    """

    sut: TopologySpec
    benchmark: str
    instances: list[str]
    manifest_ref: str = ""
    dataset_hash: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    resource: ResourceProfile = Field(default_factory=ResourceProfile)
    label: str | None = None

    @property
    def coord(self) -> dict[str, Any]:
        """The identity coordinate of the cell (excludes the instance list)."""

        return {
            "sut": self.sut.hash,
            "benchmark": self.benchmark,
            "dataset_hash": self.dataset_hash,
            "params": self.params,
        }

    @property
    def cell_id(self) -> str:
        return hash_obj(self.coord, length=12)

    def shard_id(
        self,
        instance_id: str,
        *,
        adapter_version: str,
        dataset_hash: str,
        source_sha: str = "",
        image_digest: str = "",
    ) -> str:
        """Content-addressed shard identity.

        Stable across reloads: derived only from the materialized coordinate, the
        instance, and the versions that affect the result -- never from the
        experiment code.
        """

        return hash_obj(
            {
                "cell": self.coord,
                "instance": instance_id,
                "adapter_version": adapter_version,
                "dataset_hash": dataset_hash,
                "source_sha": source_sha,
                "image_digest": image_digest,
            },
            length=16,
        )


class ShardStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUBMITTED = "submitted"  # scaffold produced an artifact (e.g. a patch)
    RESOLVED = "resolved"  # graded pass
    UNRESOLVED = "unresolved"  # graded fail
    ERROR = "error"


class ShardResult(BaseModel):
    """The durable, normalized outcome of one (cell, instance) shard.

    Writing this to the results store is the platform's checkpoint: a shard whose
    result exists is skipped on resume. Adapter-specific detail lives in ``raw``.
    """

    shard_id: str
    cell_id: str
    generation: int
    benchmark: str
    instance_id: str
    sut_hash: str
    status: ShardStatus
    resolved: bool = False
    cost_usd: float | None = None
    tokens: int | None = None
    steps: int | None = None
    latency_s: float | None = None
    failure_mode: str | None = None
    adapter_version: str = "0"
    dataset_hash: str = ""
    source_sha: str = ""
    image_digest: str = ""
    created_at: str = Field(default_factory=_utcnow)
    raw: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_resolved_status(self) -> ShardResult:
        if self.resolved != (self.status == ShardStatus.RESOLVED):
            raise ValueError(
                f"resolved={self.resolved!r} is inconsistent with "
                f"status={self.status.value!r}"
            )
        return self


class Generation(BaseModel):
    """One append to the sweep: a frozen set of cells plus why it was added.

    The lock is an append-only list of these. Each carries provenance so the
    origin of any cell is auditable even after the experiment code moves on.
    """

    index: int
    reason: str
    created_at: str = Field(default_factory=_utcnow)
    cells: list[Cell] = Field(default_factory=list)
    retired_cell_ids: list[str] = Field(default_factory=list)
    experiment_id: str | None = None
    experiment_source_hash: str | None = None
    repo_sha: str | None = None


class SubmittedShard(BaseModel):
    """Frozen identity of one shard declared to a compute backend."""

    cell_id: str
    instance_id: str
    shard_id: str
    generation: int
    benchmark: str
    sut_hash: str
    adapter_version: str
    dataset_hash: str
    source_sha: str = ""
    image_digest: str = ""


class ShardPlan(BaseModel):
    """Fully materialized shard passed to a backend without recomputation."""

    cell: Cell
    instance_id: str
    shard_id: str
    generation: int
    adapter_version: str
    source_sha: str = ""
    image_digest: str = ""

    def submitted_shard(self) -> SubmittedShard:
        return SubmittedShard(
            cell_id=self.cell.cell_id,
            instance_id=self.instance_id,
            shard_id=self.shard_id,
            generation=self.generation,
            benchmark=self.cell.benchmark,
            sut_hash=self.cell.sut.hash,
            adapter_version=self.adapter_version,
            dataset_hash=self.cell.dataset_hash,
            source_sha=self.source_sha,
            image_digest=self.image_digest,
        )


class BackendSubmission(BaseModel):
    """Backend acknowledgement for an exact set of requested shards."""

    accepted_shard_ids: list[str] = Field(default_factory=list)
    job_ids: list[str] = Field(default_factory=list)
    manifest_uris: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    image_digest: str = ""


class SubmissionState(StrEnum):
    PREPARED = "prepared"
    ACCEPTED = "accepted"
    PARTIAL = "partial"
    FAILED = "failed"


class SweepSubmission(BaseModel):
    """One apply attempt and its declared/acknowledged scientific cohort."""

    backend: str
    shards: list[SubmittedShard]
    rung: int | None = None
    only: str | None = None
    state: SubmissionState = SubmissionState.PREPARED
    accepted_shard_ids: list[str] = Field(default_factory=list)
    job_ids: list[str] = Field(default_factory=list)
    manifest_uris: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    image_digest: str = ""
    created_at: str = Field(default_factory=_utcnow)

    def accepted_shards(self) -> list[SubmittedShard]:
        accepted = set(self.accepted_shard_ids)
        return [shard for shard in self.shards if shard.shard_id in accepted]


class SweepLock(BaseModel):
    """The frozen, append-only record of a sweep.

    Materialized once at plan time and appended to on extend. Runners and resume
    read only this + the results store; determinism lives here at the shard level
    while the sweep as a whole is allowed to grow.
    """

    sweep_id: str
    created_at: str = Field(default_factory=_utcnow)
    max_vcpus: int = 64
    spend_ceiling_usd: float | None = None
    image_digest: str = ""
    generations: list[Generation] = Field(default_factory=list)
    submissions: list[SweepSubmission] = Field(default_factory=list)

    def all_cells(self) -> list[Cell]:
        return [cell for gen in self.generations for cell in gen.cells]

    def active_cells(self) -> list[Cell]:
        retired = {
            cell_id
            for generation in self.generations
            for cell_id in generation.retired_cell_ids
        }
        return [cell for cell in self.all_cells() if cell.cell_id not in retired]

    def next_generation_index(self) -> int:
        return len(self.generations)

    def submitted_shards(self) -> dict[str, dict[str, SubmittedShard]]:
        """Return backend-acknowledged shards keyed by cell and instance."""

        expected: dict[str, dict[str, SubmittedShard]] = {}
        for submission in self.submissions:
            for shard in submission.accepted_shards():
                by_instance = expected.setdefault(shard.cell_id, {})
                previous = by_instance.get(shard.instance_id)
                if previous is not None and previous.shard_id != shard.shard_id:
                    raise ValueError(
                        f"conflicting submitted shards for cell {shard.cell_id} "
                        f"instance {shard.instance_id}: "
                        f"{previous.shard_id} != {shard.shard_id}"
                    )
                by_instance[shard.instance_id] = shard
        return expected

    def submitted_instances(self) -> dict[str, set[str]]:
        return {
            cell_id: set(by_instance)
            for cell_id, by_instance in self.submitted_shards().items()
        }

    def declared_shard_ids(self) -> set[str]:
        """All explicitly declared shards, including interrupted submissions."""

        return {
            shard.shard_id
            for submission in self.submissions
            for shard in submission.shards
        }


class RunResult(BaseModel):
    """Aggregated view of a sweep: per-cell tables built from ShardResults."""

    sweep_id: str
    cells: list[dict[str, Any]] = Field(default_factory=list)
    generated_at: str = Field(default_factory=_utcnow)
