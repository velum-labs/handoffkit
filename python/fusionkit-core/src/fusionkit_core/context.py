"""Deterministic context budgeting for the judge and synthesizer prompts.

FusionKit implements no first-party conversation compaction — the launched
coding tool owns its session state and compacts it itself (see the plan's
architecture decision). What FusionKit *does* own is the candidate-trajectory
evidence it injects into the judge and synthesizer prompts, and that evidence
is unbounded: a long agentic run yields hundreds of items per trajectory, and
nothing else will ever shrink it. This module is the single, deterministic
"compactor" for that evidence:

- :func:`estimate_tokens` — dependency-free chars/4 heuristic (a safety margin
  in :class:`ContextBudget` absorbs its error; no tiktoken).
- :class:`ContextBudget` — a model call's usable prompt budget, derived from
  the endpoint's context window minus reserved output and the safety margin.
- :func:`pack_trajectories` — middle-out packing of trajectories to a token
  budget, in strict degradation tiers (elide middle items, then drop items,
  then drop failed trajectories), never dropping the last succeeded
  trajectory's final output. Pure and deterministic: no model calls, always
  terminates, same input -> same output.

Costs are measured against the *rendered* judge/synthesizer representation
(:func:`fusionkit_core.prompts.format_trajectories`), so the budget reflects
what is actually sent, not the raw payload.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from fusionkit_core.config import ContextPolicy, SamplingConfig
from fusionkit_core.contracts import TrajectoryItem
from fusionkit_core.prompts import format_trajectories
from fusionkit_core.types import ChatMessage, Trajectory

# Rendered marker for an elided middle. A plain `message` item so it stays
# inside the wire `TrajectoryItem` type union (no contract change) and reads
# as an explicit gap to the judge rather than a silent one.
_ELISION_TEMPLATE = "[... {count} intermediate items elided to fit the context budget ...]"


def estimate_tokens(text: str) -> int:
    """Estimate the token count of ``text`` (chars/4, rounded up).

    Deliberately dependency-free; :class:`ContextBudget.safety_margin` absorbs
    the heuristic's error instead of a tokenizer dependency.
    """
    if not text:
        return 0
    return -(-len(text) // 4)


def estimate_messages_tokens(messages: Sequence[ChatMessage]) -> int:
    """Estimate the token cost of a chat conversation body."""
    return sum(estimate_tokens(message.content) + 4 for message in messages)


@dataclass(frozen=True)
class ContextBudget:
    """The usable prompt budget for one model call.

    ``max_context`` is the model's context window (the endpoint's declared
    ``max_context``, or the policy default when undeclared); ``reserved_output``
    is the sampling ``max_tokens`` the completion may consume; ``safety_margin``
    absorbs token-estimation error.
    """

    max_context: int
    reserved_output: int
    safety_margin: int

    @classmethod
    def for_model(
        cls,
        max_context: int | None,
        sampling: SamplingConfig,
        policy: ContextPolicy,
    ) -> ContextBudget:
        return cls(
            max_context=max_context if max_context is not None else policy.default_max_context,
            reserved_output=sampling.max_tokens,
            safety_margin=policy.safety_margin_tokens,
        )

    @property
    def prompt_tokens(self) -> int:
        """Tokens available for the entire prompt (system + conversation + evidence)."""
        return max(0, self.max_context - self.reserved_output - self.safety_margin)

    def evidence_tokens(self, overhead_tokens: int) -> int:
        """Tokens left for trajectory evidence after ``overhead_tokens`` of prompt."""
        return max(0, self.prompt_tokens - overhead_tokens)


@dataclass(frozen=True)
class TrajectoryPack:
    """What packing did to one trajectory."""

    trajectory_id: str
    original_items: int
    kept_items: int
    dropped: bool = False


@dataclass(frozen=True)
class PackReport:
    """Observability record of one packing pass (folds into synthesis metrics)."""

    budget_tokens: int
    estimated_tokens_before: int
    estimated_tokens_after: int
    trajectories: tuple[TrajectoryPack, ...] = ()

    @property
    def changed(self) -> bool:
        return any(
            pack.dropped or pack.kept_items < pack.original_items for pack in self.trajectories
        )

    def to_metrics(self) -> dict[str, object]:
        return {
            "budget_tokens": self.budget_tokens,
            "estimated_tokens_before": self.estimated_tokens_before,
            "estimated_tokens_after": self.estimated_tokens_after,
            "trajectories": [
                {
                    "trajectory_id": pack.trajectory_id,
                    "original_items": pack.original_items,
                    "kept_items": pack.kept_items,
                    "dropped": pack.dropped,
                }
                for pack in self.trajectories
            ],
        }


@dataclass
class _Entry:
    """Mutable packing state for one trajectory."""

    trajectory: Trajectory
    original_items: int
    dropped: bool = False
    cost: int = field(default=0)

    def remeasure(self) -> None:
        self.cost = 0 if self.dropped else _trajectory_cost(self.trajectory)


def _trajectory_cost(trajectory: Trajectory) -> int:
    """Token cost of one trajectory as the judge/synthesizer will see it."""
    return estimate_tokens(format_trajectories([trajectory]))


def _elide_middle(trajectory: Trajectory, keep_head: int, keep_tail: int) -> Trajectory:
    """Keep the first/last items and replace the middle with one marker item."""
    items = trajectory.items
    if len(items) <= keep_head + keep_tail + 1:
        return trajectory
    elided_count = len(items) - keep_head - keep_tail
    head = list(items[:keep_head])
    tail = list(items[len(items) - keep_tail :])
    marker = TrajectoryItem(
        index=items[keep_head].index,
        type="message",
        text=_ELISION_TEMPLATE.format(count=elided_count),
    )
    return trajectory.model_copy(update={"items": [*head, marker, *tail]})


def _drop_items(trajectory: Trajectory) -> Trajectory:
    """Reduce a trajectory to its final output only."""
    if not trajectory.items:
        return trajectory
    return trajectory.model_copy(update={"items": []})


def _over_budget(entries: list[_Entry], budget_tokens: int) -> bool:
    return sum(entry.cost for entry in entries) > budget_tokens


def _by_cost_desc(entries: list[_Entry]) -> list[_Entry]:
    """Largest-first, trajectory id as the deterministic tie-break."""
    return sorted(entries, key=lambda entry: (-entry.cost, entry.trajectory.id))


def pack_trajectories(
    trajectories: Sequence[Trajectory],
    budget_tokens: int,
    *,
    policy: ContextPolicy | None = None,
) -> tuple[list[Trajectory], PackReport]:
    """Pack ``trajectories`` into ``budget_tokens``, degrading in strict tiers.

    Tier 1: middle-out — elide middle items (keep head/tail per ``policy``) of
    the costliest trajectories until under budget.
    Tier 2: drop all items of the costliest trajectories (final output only).
    Tier 3: drop failed trajectories entirely, costliest first.

    The last succeeded trajectory's final output is never dropped (if nothing
    succeeded, the last trajectory overall survives), so the judge and
    synthesizer always retain at least one candidate answer; any residual
    overflow is the caller's overflow ladder's problem.
    """
    resolved = policy or ContextPolicy()
    entries = [
        _Entry(trajectory=trajectory, original_items=len(trajectory.items))
        for trajectory in trajectories
    ]
    for entry in entries:
        entry.remeasure()
    before = sum(entry.cost for entry in entries)

    # Tier 1: middle-out elision, costliest first, stopping once under budget.
    if _over_budget(entries, budget_tokens):
        for entry in _by_cost_desc(entries):
            packed = _elide_middle(
                entry.trajectory, resolved.keep_head_items, resolved.keep_tail_items
            )
            if packed is not entry.trajectory:
                entry.trajectory = packed
                entry.remeasure()
            if not _over_budget(entries, budget_tokens):
                break

    # Tier 2: strip items down to the final output, costliest first.
    if _over_budget(entries, budget_tokens):
        for entry in _by_cost_desc(entries):
            stripped = _drop_items(entry.trajectory)
            if stripped is not entry.trajectory:
                entry.trajectory = stripped
                entry.remeasure()
            if not _over_budget(entries, budget_tokens):
                break

    # Tier 3: drop failed trajectories entirely, costliest first.
    if _over_budget(entries, budget_tokens):
        for entry in _by_cost_desc(entries):
            if entry.trajectory.status == "succeeded" or entry.dropped:
                continue
            entry.dropped = True
            entry.remeasure()
            if not _over_budget(entries, budget_tokens):
                break

    # Floor: at least one candidate answer always survives. Prefer the last
    # succeeded trajectory (matching _best_trajectory_output's preference).
    survivors = [entry for entry in entries if not entry.dropped]
    if not survivors and entries:
        keeper = next(
            (
                entry
                for entry in reversed(entries)
                if entry.trajectory.status == "succeeded"
            ),
            entries[-1],
        )
        keeper.dropped = False
        keeper.remeasure()

    packed = [entry.trajectory for entry in entries if not entry.dropped]
    report = PackReport(
        budget_tokens=budget_tokens,
        estimated_tokens_before=before,
        estimated_tokens_after=sum(entry.cost for entry in entries),
        trajectories=tuple(
            TrajectoryPack(
                trajectory_id=entry.trajectory.id,
                original_items=entry.original_items,
                kept_items=0 if entry.dropped else len(entry.trajectory.items),
                dropped=entry.dropped,
            )
            for entry in entries
        ),
    )
    return packed, report


__all__ = [
    "ContextBudget",
    "PackReport",
    "TrajectoryPack",
    "estimate_messages_tokens",
    "estimate_tokens",
    "pack_trajectories",
]
