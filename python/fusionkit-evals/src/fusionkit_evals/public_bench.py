"""Real public coding benchmarks run against the fusion gateway.

Strategy (see the plan): do not reimplement benchmark tasks or verifiers. Run
each suite's *official* runner against the fusion gateway (treated as one model)
and compare the fused result to the *published* per-model leaderboard. This module
owns the suite registry, the committed leaderboard baselines, and the executor
protocol that drives an external runner adapter and ingests its normalized output.

It deliberately does not download datasets or call providers itself: an external
runner adapter (a thin wrapper the operator supplies around the official harness)
does that and emits a normalized JSON envelope on stdout. When the adapter is
absent or its credentials are missing, the run is reported as ``unavailable``
rather than failing, so CI stays green.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from fusionkit_evals.benchmark_panel import BenchmarkPanel, PanelHeadroom, estimate_panel_headroom

PUBLIC_BENCH_DISCLAIMER = (
    "external public-benchmark comparison; fusion numbers are measured from this run, while "
    "baseline numbers are cited from public leaderboards and may use a different harness version "
    "or date"
)

PublicBenchmarkSuite = Literal[
    "aider-polyglot",
    "swe-bench-pro",
    "terminal-bench",
    "livecodebench",
]
PUBLIC_BENCHMARK_SUITES: tuple[PublicBenchmarkSuite, ...] = (
    "aider-polyglot",
    "swe-bench-pro",
    "terminal-bench",
    "livecodebench",
)

# Where fusion sits relative to the benchmark's agent loop.
FusionMountMode = Literal["fusion_as_agent", "fusion_behind_agent"]

ExternalBenchmarkAvailability = Literal["ran", "unavailable", "failed"]


class PublishedBaseline(BaseModel):
    """A single published leaderboard entry used as a comparison baseline."""

    suite: PublicBenchmarkSuite
    model: str
    score: float = Field(ge=0.0, le=1.0)
    cost_per_run_usd: float | None = Field(default=None, ge=0.0)
    attempts: int | None = Field(default=None, ge=1)
    harness: str | None = None
    contamination_controlled: bool = False
    as_of: str
    source: str


class PublicBenchmarkInfo(BaseModel):
    """Static metadata describing how a public suite is run and compared."""

    suite: PublicBenchmarkSuite
    display_name: str
    mount_mode: FusionMountMode
    default_dialect: str
    default_gateway_model: str
    task_count: int | None = None
    verifier: str
    contamination_note: str
    leaderboard_url: str
    official_runner: str
    notes: str = ""


PUBLIC_BENCHMARK_INFO: dict[PublicBenchmarkSuite, PublicBenchmarkInfo] = {
    "aider-polyglot": PublicBenchmarkInfo(
        suite="aider-polyglot",
        display_name="Aider polyglot",
        mount_mode="fusion_behind_agent",
        default_dialect="openai-chat",
        default_gateway_model="fusionkit/panel",
        task_count=225,
        verifier="aider runs each exercise's unit tests after up to two attempts",
        contamination_note=(
            "public Exercism tasks; baselines run the identical harness so the relative "
            "comparison stays meaningful"
        ),
        leaderboard_url="https://aider.chat/docs/leaderboards/",
        official_runner="aider --benchmark (pointed at the gateway base URL)",
        notes=(
            "cleanest single-variable ablation: identical harness with published per-model "
            "scores and a built-in cost column"
        ),
    ),
    "swe-bench-pro": PublicBenchmarkInfo(
        suite="swe-bench-pro",
        display_name="SWE-bench Pro",
        mount_mode="fusion_as_agent",
        default_dialect="openai-chat",
        default_gateway_model="fusionkit/panel",
        task_count=None,
        verifier="official secure harness applies the predicted patch and runs the repo tests",
        contamination_note=(
            "current real-world-SWE standard with a private held-out split; replaces deprecated "
            "SWE-bench Verified"
        ),
        leaderboard_url="https://scale.com/leaderboard/swe_bench_pro_public",
        official_runner="swe-bench-pro harness with fusion as the patch-producing agent",
        notes="primary real-world headline; do NOT use deprecated SWE-bench Verified",
    ),
    "terminal-bench": PublicBenchmarkInfo(
        suite="terminal-bench",
        display_name="Terminal-Bench 2.x",
        mount_mode="fusion_as_agent",
        default_dialect="openai-chat",
        default_gateway_model="fusionkit/panel",
        task_count=89,
        verifier="each task runs in a Docker container; tests verify final container state",
        contamination_note=(
            "intentionally kept under a ~50% ceiling (not saturated); every leaderboard row is "
            "an Agent+Model pair"
        ),
        leaderboard_url="https://www.tbench.ai/leaderboard",
        official_runner="terminal-bench harness with FusionKit submitted as a new Agent+Model row",
        notes="agentic headline; fusion is naturally a new agent here",
    ),
    "livecodebench": PublicBenchmarkInfo(
        suite="livecodebench",
        display_name="LiveCodeBench",
        mount_mode="fusion_behind_agent",
        default_dialect="openai-chat",
        default_gateway_model="fusionkit/panel",
        task_count=None,
        verifier="hidden test cases for post-cutoff competitive programming problems",
        contamination_note=(
            "contamination-free via a time window after the panel models' training cutoffs"
        ),
        leaderboard_url="https://livecodebench.github.io/leaderboard.html",
        official_runner="livecodebench runner with a post-cutoff time window",
        notes="optional contamination-controlled cross-check; non-agentic generation",
    ),
}

# Published leaderboard standings (as of 2026-06) used as baselines. Scores are
# normalized to 0..1. These are cited references, not measured here.
PUBLIC_BENCHMARK_BASELINES: tuple[PublishedBaseline, ...] = (
    # Aider polyglot (pass rate after 2 attempts; cost per run where published).
    PublishedBaseline(
        suite="aider-polyglot", model="gpt-5.5", score=0.88, cost_per_run_usd=29.08,
        attempts=2, harness="aider", as_of="2026-05", source="aider.chat/docs/leaderboards",
    ),
    PublishedBaseline(
        suite="aider-polyglot", model="o3-pro", score=0.849, cost_per_run_usd=146.32,
        attempts=2, harness="aider", as_of="2026-05", source="aider.chat/docs/leaderboards",
    ),
    PublishedBaseline(
        suite="aider-polyglot", model="gemini-2.5-pro", score=0.831, cost_per_run_usd=49.88,
        attempts=2, harness="aider", as_of="2026-05", source="aider.chat/docs/leaderboards",
    ),
    PublishedBaseline(
        suite="aider-polyglot", model="deepseek-v3.2", score=0.742, cost_per_run_usd=1.30,
        attempts=2, harness="aider", as_of="2026-05", source="aider.chat/docs/leaderboards",
    ),
    PublishedBaseline(
        suite="aider-polyglot", model="claude-opus-4", score=0.72, cost_per_run_usd=65.75,
        attempts=2, harness="aider", as_of="2026-05", source="aider.chat/docs/leaderboards",
    ),
    # SWE-bench Pro (public split).
    PublishedBaseline(
        suite="swe-bench-pro", model="claude-mythos", score=0.803,
        as_of="2026-06", source="scale.com swe-bench-pro public leaderboard",
    ),
    PublishedBaseline(
        suite="swe-bench-pro", model="claude-opus-4.8", score=0.78,
        as_of="2026-06", source="scale.com swe-bench-pro public leaderboard",
    ),
    PublishedBaseline(
        suite="swe-bench-pro", model="gpt-5.5", score=0.75,
        as_of="2026-06", source="scale.com swe-bench-pro public leaderboard",
    ),
    PublishedBaseline(
        suite="swe-bench-pro", model="gpt-5.3-codex", score=0.568,
        as_of="2026-06", source="scale.com swe-bench-pro public leaderboard",
    ),
    PublishedBaseline(
        suite="swe-bench-pro", model="claude-sonnet-4-6", score=0.45,
        as_of="2026-06", source="scale.com swe-bench-pro public leaderboard",
    ),
    # Terminal-Bench 2.x (resolution rate; rows are Agent+Model).
    PublishedBaseline(
        suite="terminal-bench", model="gpt-5.3-codex", score=0.615, harness="codex-cli",
        as_of="2026-06", source="awesomeagents coding benchmarks leaderboard",
    ),
    PublishedBaseline(
        suite="terminal-bench", model="claude-opus-4.6", score=0.583, harness="claude-code",
        as_of="2026-06", source="awesomeagents coding benchmarks leaderboard",
    ),
    PublishedBaseline(
        suite="terminal-bench", model="gemini-3-pro", score=0.503,
        as_of="2026-06", source="awesomeagents coding benchmarks leaderboard",
    ),
    # LiveCodeBench (pass@1, contamination-free).
    PublishedBaseline(
        suite="livecodebench", model="deepseek-v4-pro", score=0.935,
        contamination_controlled=True, as_of="2026-06", source="benchlm.ai livecodebench",
    ),
    PublishedBaseline(
        suite="livecodebench", model="gpt-5.3-codex", score=0.712,
        contamination_controlled=True, as_of="2026-06",
        source="awesomeagents coding benchmarks leaderboard",
    ),
    PublishedBaseline(
        suite="livecodebench", model="claude-opus-4.6", score=0.681,
        contamination_controlled=True, as_of="2026-06",
        source="awesomeagents coding benchmarks leaderboard",
    ),
)


class ExternalBenchmarkRequest(BaseModel):
    """The task handed to an external benchmark runner adapter."""

    suite: PublicBenchmarkSuite
    mount_mode: FusionMountMode
    gateway_base_url: str
    gateway_model: str
    panel_id: str
    subset: int | None = Field(default=None, ge=1)
    task_ids: list[str] = Field(default_factory=list)


TaskOutcome = Literal["scored", "model_failed", "infra_error", "excluded"]


class ExternalBenchmarkTaskRow(BaseModel):
    """One scored task from an external benchmark run."""

    task_id: str
    # scored = measured; model_failed/infra_error/excluded keep the task in the
    # accounting instead of silently dropping it (which would bias the score).
    outcome: TaskOutcome = "scored"
    passed: bool | None = None
    score: float | None = None
    cost_usd: float | None = None
    latency_s: float | None = None
    # Per-panel-member success on this task (when the adapter exposes candidates),
    # enabling oracle/diversity metrics from the run itself.
    candidate_scores: dict[str, float] = Field(default_factory=dict)
    error_reason: str | None = None


class ExternalBenchmarkRun(BaseModel):
    """Normalized result of running one public suite against the gateway."""

    suite: PublicBenchmarkSuite
    mount_mode: FusionMountMode
    availability: ExternalBenchmarkAvailability
    panel_id: str
    gateway_model: str
    harness: str | None = None
    harness_version: str | None = None
    resolved_tasks: int = 0
    total_tasks: int = 0
    passed_tasks: int = 0
    # Taxonomy counts so infra failures and exclusions never distort the score.
    model_failed_tasks: int = 0
    infra_error_tasks: int = 0
    excluded_tasks: int = 0
    score: float | None = None
    cost_total_usd: float | None = None
    cost_per_task_usd: float | None = None
    tasks: list[ExternalBenchmarkTaskRow] = Field(default_factory=list)
    unavailable_reason: str | None = None
    provenance: dict[str, Any] = Field(default_factory=dict)
    raw_metadata: dict[str, Any] = Field(default_factory=dict)


class ExternalBenchmarkUnavailable(RuntimeError):
    """The external runner adapter is not installed or its credentials are absent."""


class ExternalBenchmarkError(RuntimeError):
    """The external runner adapter ran but failed or produced invalid output."""


class ExternalBenchmarkExecutor(Protocol):
    async def run(self, request: ExternalBenchmarkRequest) -> ExternalBenchmarkRun:
        raise NotImplementedError


class CommandExternalBenchmarkExecutor:
    """Drive an external runner adapter as a subprocess.

    The command receives the :class:`ExternalBenchmarkRequest` as JSON on stdin and
    must emit a normalized run envelope on stdout (see :func:`parse_external_run`).
    A missing binary raises :class:`ExternalBenchmarkUnavailable`; a non-zero exit
    or unparsable output raises :class:`ExternalBenchmarkError`.
    """

    def __init__(
        self,
        command: Sequence[str] | str,
        *,
        timeout_s: float = 1800.0,
        cwd: str | Path | None = None,
        env: Mapping[str, str | None] | None = None,
    ) -> None:
        self.command = shlex.split(command) if isinstance(command, str) else list(command)
        self.timeout_s = timeout_s
        self.cwd = Path(cwd) if cwd is not None else None
        self.env = dict(env) if env is not None else None
        if not self.command:
            raise ValueError("external benchmark command must not be empty")

    def _subprocess_env(self) -> dict[str, str] | None:
        if self.env is None:
            return None
        merged = os.environ.copy()
        for key, value in self.env.items():
            if value is None:
                merged.pop(key, None)
            else:
                merged[key] = value
        return merged

    async def run(self, request: ExternalBenchmarkRequest) -> ExternalBenchmarkRun:
        payload = request.model_dump(mode="json")
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command,
                cwd=str(self.cwd) if self.cwd is not None else None,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._subprocess_env(),
            )
        except FileNotFoundError as exc:
            raise ExternalBenchmarkUnavailable(str(exc)) from exc
        encoded = json.dumps(payload).encode()
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(encoded),
                timeout=self.timeout_s,
            )
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise ExternalBenchmarkError(
                f"external benchmark command timed out after {self.timeout_s:.1f}s"
            ) from exc
        if process.returncode != 0:
            stderr_text = stderr.decode(errors="replace").strip()
            raise ExternalBenchmarkError(
                f"external benchmark command exited with {process.returncode}: {stderr_text}"
            )
        return parse_external_run(stdout.decode(), request)


def parse_external_run(
    output: str,
    request: ExternalBenchmarkRequest,
) -> ExternalBenchmarkRun:
    stripped = output.strip()
    if not stripped:
        raise ExternalBenchmarkError("external benchmark adapter produced no output")
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ExternalBenchmarkError(f"external benchmark output is not JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ExternalBenchmarkError("external benchmark output must be a JSON object")
    suite = parsed.get("suite", request.suite)
    if suite != request.suite:
        raise ExternalBenchmarkError(
            f"external benchmark output suite {suite!r} does not match request {request.suite!r}"
        )
    tasks = [_parse_task_row(row) for row in parsed.get("tasks", []) if isinstance(row, dict)]
    scored = [row for row in tasks if row.outcome == "scored"]
    # The denominator is scored tasks only; infra errors and exclusions are tracked
    # separately so a transient failure on a hard task can't inflate the score.
    resolved_tasks = _as_int(parsed.get("resolved_tasks"), default=len(scored))
    total_tasks = _as_int(parsed.get("total_tasks"), default=len(tasks))
    passed_tasks = _as_int(
        parsed.get("passed_tasks"),
        default=sum(1 for row in scored if row.passed),
    )
    score = _as_float(parsed.get("score"))
    if score is None and resolved_tasks > 0:
        score = passed_tasks / resolved_tasks
    cost_total = _as_float(parsed.get("cost_total_usd"))
    if cost_total is None:
        task_costs = [row.cost_usd for row in tasks if row.cost_usd is not None]
        cost_total = sum(task_costs) if task_costs else None
    cost_per_task = _as_float(parsed.get("cost_per_task_usd"))
    if cost_per_task is None and cost_total is not None and resolved_tasks > 0:
        cost_per_task = cost_total / resolved_tasks
    provenance = parsed.get("provenance", {})
    return ExternalBenchmarkRun(
        suite=request.suite,
        mount_mode=request.mount_mode,
        availability="ran",
        panel_id=request.panel_id,
        gateway_model=request.gateway_model,
        harness=_as_str(parsed.get("harness")),
        harness_version=_as_str(parsed.get("harness_version")),
        resolved_tasks=resolved_tasks,
        total_tasks=total_tasks,
        passed_tasks=passed_tasks,
        model_failed_tasks=sum(1 for row in tasks if row.outcome == "model_failed"),
        infra_error_tasks=sum(1 for row in tasks if row.outcome == "infra_error"),
        excluded_tasks=sum(1 for row in tasks if row.outcome == "excluded"),
        score=score,
        cost_total_usd=cost_total,
        cost_per_task_usd=cost_per_task,
        tasks=tasks,
        provenance=provenance if isinstance(provenance, dict) else {},
        raw_metadata=parsed.get("metadata", {}) if isinstance(parsed.get("metadata"), dict) else {},
    )


async def run_public_benchmark(
    request: ExternalBenchmarkRequest,
    executor: ExternalBenchmarkExecutor | None,
) -> ExternalBenchmarkRun:
    """Run one suite, returning an availability-tagged result instead of raising."""

    if executor is None:
        return _unavailable_run(request, "external benchmark runner not configured")
    try:
        return await executor.run(request)
    except ExternalBenchmarkUnavailable as exc:
        return _unavailable_run(request, str(exc) or "external benchmark runner unavailable")
    except (ExternalBenchmarkError, ValueError) as exc:
        return ExternalBenchmarkRun(
            suite=request.suite,
            mount_mode=request.mount_mode,
            availability="failed",
            panel_id=request.panel_id,
            gateway_model=request.gateway_model,
            unavailable_reason=str(exc),
        )


def baselines_for(suite: PublicBenchmarkSuite) -> list[PublishedBaseline]:
    return sorted(
        (baseline for baseline in PUBLIC_BENCHMARK_BASELINES if baseline.suite == suite),
        key=lambda baseline: baseline.score,
        reverse=True,
    )


def best_baseline(suite: PublicBenchmarkSuite) -> PublishedBaseline | None:
    ranked = baselines_for(suite)
    return ranked[0] if ranked else None


def panel_member_published_scores(
    panel: BenchmarkPanel,
    suite: PublicBenchmarkSuite,
) -> dict[str, float]:
    """Map each panel member id -> its published single-model score on ``suite``."""

    by_model = {baseline.model.lower(): baseline.score for baseline in baselines_for(suite)}
    scores: dict[str, float] = {}
    for member in panel.members:
        score = by_model.get(member.model.lower())
        if score is not None:
            scores[member.id] = score
    return scores


def panel_headroom_for_suite(
    panel: BenchmarkPanel,
    suite: PublicBenchmarkSuite,
) -> PanelHeadroom:
    return estimate_panel_headroom(panel, suite, panel_member_published_scores(panel, suite))


def assert_public_benchmark_registry() -> None:
    """Guard that every suite has info and at least one baseline."""

    for suite in PUBLIC_BENCHMARK_SUITES:
        if suite not in PUBLIC_BENCHMARK_INFO:
            raise ValueError(f"missing PublicBenchmarkInfo for suite {suite!r}")
        if not baselines_for(suite):
            raise ValueError(f"missing published baselines for suite {suite!r}")
    unexpected = sorted(set(PUBLIC_BENCHMARK_INFO) - set(PUBLIC_BENCHMARK_SUITES))
    if unexpected:
        raise ValueError(f"unexpected suites in PUBLIC_BENCHMARK_INFO: {unexpected}")


def _unavailable_run(request: ExternalBenchmarkRequest, reason: str) -> ExternalBenchmarkRun:
    return ExternalBenchmarkRun(
        suite=request.suite,
        mount_mode=request.mount_mode,
        availability="unavailable",
        panel_id=request.panel_id,
        gateway_model=request.gateway_model,
        unavailable_reason=reason,
    )


def _parse_task_row(row: Mapping[str, Any]) -> ExternalBenchmarkTaskRow:
    candidate_scores = {
        str(key): float(value)
        for key, value in (row.get("candidate_scores") or {}).items()
        if isinstance(value, int | float)
    }
    outcome = row.get("outcome")
    resolved_outcome: TaskOutcome = (
        outcome if outcome in ("scored", "model_failed", "infra_error", "excluded") else "scored"
    )
    return ExternalBenchmarkTaskRow(
        task_id=str(row.get("task_id", "")),
        outcome=resolved_outcome,
        passed=row.get("passed") if isinstance(row.get("passed"), bool) else None,
        score=_as_float(row.get("score")),
        cost_usd=_as_float(row.get("cost_usd")),
        latency_s=_as_float(row.get("latency_s")),
        candidate_scores=candidate_scores,
        error_reason=_as_str(row.get("error_reason")),
    )


def _as_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int | float):
        return int(value)
    return default


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def write_external_runs_jsonl(path: str | Path, runs: Iterable[ExternalBenchmarkRun]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for run in runs:
            handle.write(json.dumps(run.model_dump(mode="json")) + "\n")


__all__ = [
    "PUBLIC_BENCHMARK_BASELINES",
    "PUBLIC_BENCHMARK_INFO",
    "PUBLIC_BENCHMARK_SUITES",
    "PUBLIC_BENCH_DISCLAIMER",
    "CommandExternalBenchmarkExecutor",
    "ExternalBenchmarkAvailability",
    "ExternalBenchmarkError",
    "ExternalBenchmarkExecutor",
    "ExternalBenchmarkRequest",
    "ExternalBenchmarkRun",
    "ExternalBenchmarkTaskRow",
    "ExternalBenchmarkUnavailable",
    "FusionMountMode",
    "PublicBenchmarkInfo",
    "PublicBenchmarkSuite",
    "PublishedBaseline",
    "TaskOutcome",
    "assert_public_benchmark_registry",
    "baselines_for",
    "best_baseline",
    "panel_headroom_for_suite",
    "panel_member_published_scores",
    "parse_external_run",
    "run_public_benchmark",
    "write_external_runs_jsonl",
]
