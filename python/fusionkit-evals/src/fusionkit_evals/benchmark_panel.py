"""Benchmark panel composition.

A fusion benchmark is really a benchmark of *panel diversity*: fusion can only
beat the best single model when the panel's members fail on different tasks. The
shipping product default (one strong model plus a much weaker one) is lopsided -
the oracle ceiling barely exceeds the best single model, so fusion has almost no
headroom to demonstrate value.

This module defines the panels used for benchmarking (a decorrelated peer panel
and the lopsided default kept only for contrast) and a numeric headroom estimate
that, given each member's *published* score on a suite, reports the best single
model, an optimistic oracle ceiling, and whether the panel is lopsided. The
headroom estimate is intentionally pure arithmetic so it has no dependency on the
benchmark suites themselves (``public_bench`` imports this module, never the
reverse).
"""

from __future__ import annotations

import math
from collections.abc import Mapping

from fusionkit_core.config import (
    FusionConfig,
    ModelEndpoint,
    ProviderKind,
    SamplingConfig,
)
from pydantic import BaseModel, Field, model_validator

# Lopsided panels make fusion look pointless: when the best member beats the
# next-best by more than this margin, the oracle ceiling is dominated by a single
# model and there is little for the judge to gain.
LOPSIDED_SCORE_GAP = 0.2

DEFAULT_PROVIDER_BASE_URLS: dict[ProviderKind, str] = {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com",
}

DEFAULT_PROVIDER_KEY_ENVS: dict[ProviderKind, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
}


class BenchmarkPanelMember(BaseModel):
    """A single solver model in a benchmark panel."""

    id: str
    model: str
    provider: ProviderKind = "openai"
    base_url: str | None = None
    api_key_env: str | None = None

    def resolved_base_url(self) -> str:
        if self.base_url is not None:
            return self.base_url
        base_url = DEFAULT_PROVIDER_BASE_URLS.get(self.provider)
        if base_url is None:
            raise ValueError(
                f"panel member {self.id!r} (provider {self.provider!r}) needs an explicit base_url"
            )
        return base_url

    def resolved_api_key_env(self) -> str | None:
        if self.api_key_env is not None:
            return self.api_key_env
        return DEFAULT_PROVIDER_KEY_ENVS.get(self.provider)


class BenchmarkPanel(BaseModel):
    """A panel of solver models plus a judge for fusion benchmarking."""

    panel_id: str
    members: list[BenchmarkPanelMember]
    judge_id: str
    synthesizer_id: str | None = None
    note: str = ""

    @model_validator(mode="after")
    def _validate_panel(self) -> BenchmarkPanel:
        if len(self.members) < 2:
            raise ValueError(f"benchmark panel {self.panel_id!r} needs at least two members")
        ids = [member.id for member in self.members]
        duplicates = sorted({member_id for member_id in ids if ids.count(member_id) > 1})
        if duplicates:
            raise ValueError(f"benchmark panel {self.panel_id!r} has duplicate ids: {duplicates}")
        if self.judge_id not in ids:
            raise ValueError(
                f"benchmark panel {self.panel_id!r} judge_id {self.judge_id!r} is not a member"
            )
        if self.synthesizer_id is not None and self.synthesizer_id not in ids:
            raise ValueError(
                f"benchmark panel {self.panel_id!r} synthesizer_id {self.synthesizer_id!r} "
                "is not a member"
            )
        return self

    @property
    def member_ids(self) -> list[str]:
        return [member.id for member in self.members]

    @property
    def resolved_synthesizer_id(self) -> str:
        return self.synthesizer_id or self.judge_id

    def member_for(self, member_id: str) -> BenchmarkPanelMember:
        for member in self.members:
            if member.id == member_id:
                return member
        raise KeyError(f"unknown panel member: {member_id}")

    def to_fusion_config(
        self,
        *,
        sampling: SamplingConfig | None = None,
    ) -> FusionConfig:
        """Render this panel as a :class:`FusionConfig` for ``fusionkit serve``."""

        endpoints = [
            ModelEndpoint(
                id=member.id,
                model=member.model,
                base_url=member.resolved_base_url(),
                api_key_env=member.resolved_api_key_env(),
                provider=member.provider,
            )
            for member in self.members
        ]
        return FusionConfig(
            endpoints=endpoints,
            default_model=self.members[0].id,
            judge_model=self.judge_id,
            synthesizer_model=self.resolved_synthesizer_id,
            default_mode="panel",
            panel_models=self.member_ids,
            sampling=sampling or SamplingConfig(),
        )


class PanelHeadroom(BaseModel):
    """Whether a panel has room for fusion to beat its best single member."""

    panel_id: str
    suite: str
    member_scores: dict[str, float] = Field(default_factory=dict)
    best_single_model: str | None = None
    best_single_score: float | None = None
    second_best_score: float | None = None
    score_spread: float | None = None
    oracle_ceiling: float | None = None
    oracle_headroom: float | None = None
    lopsided: bool = False
    note: str = ""


def estimate_panel_headroom(
    panel: BenchmarkPanel,
    suite: str,
    member_scores: Mapping[str, float],
) -> PanelHeadroom:
    """Estimate fusion headroom from members' published single-model scores.

    ``member_scores`` maps panel member id -> published pass rate on ``suite``
    (0..1). The oracle ceiling assumes *independent* failures (the optimistic
    case) as ``1 - prod(1 - score)``; the headroom is that ceiling minus the best
    single member. A panel is flagged ``lopsided`` when the best member beats the
    next best by more than :data:`LOPSIDED_SCORE_GAP`, in which case fusion has
    little to gain regardless of judge quality.
    """

    scored = {
        member_id: float(member_scores[member_id])
        for member_id in panel.member_ids
        if member_id in member_scores
    }
    if not scored:
        return PanelHeadroom(
            panel_id=panel.panel_id,
            suite=suite,
            note="no published member scores available for this suite",
        )
    ordered = sorted(scored.values(), reverse=True)
    best_single_score = ordered[0]
    best_single_model = max(scored, key=lambda member_id: scored[member_id])
    second_best_score = ordered[1] if len(ordered) > 1 else None
    score_spread = best_single_score - ordered[-1]
    oracle_ceiling = 1.0 - math.prod(1.0 - score for score in scored.values())
    oracle_headroom = oracle_ceiling - best_single_score
    lopsided = (
        second_best_score is not None
        and (best_single_score - second_best_score) > LOPSIDED_SCORE_GAP
    )
    note = (
        "lopsided panel: one member dominates, so the oracle ceiling barely exceeds the "
        "best single model and fusion has little headroom"
        if lopsided
        else "balanced panel: decorrelated peers leave oracle headroom for fusion to exploit"
    )
    return PanelHeadroom(
        panel_id=panel.panel_id,
        suite=suite,
        member_scores=scored,
        best_single_model=best_single_model,
        best_single_score=best_single_score,
        second_best_score=second_best_score,
        score_spread=score_spread,
        oracle_ceiling=oracle_ceiling,
        oracle_headroom=oracle_headroom,
        lopsided=lopsided,
        note=note,
    )


# The recommended benchmark panel: decorrelated frontier peers (comparable
# strength, different model families) so fusion has real oracle headroom.
DECORRELATED_PEER_PANEL = BenchmarkPanel(
    panel_id="decorrelated-peers",
    members=[
        BenchmarkPanelMember(id="gpt", model="gpt-5.5", provider="openai"),
        BenchmarkPanelMember(id="opus", model="claude-opus-4.8", provider="anthropic"),
        BenchmarkPanelMember(id="gemini", model="gemini-3-pro", provider="google"),
    ],
    judge_id="gpt",
    note="decorrelated frontier peers chosen for diversity, not for matching the product default",
)

# The shipping product default, kept only as a contrast: it is lopsided, so it is
# the wrong panel to benchmark fusion with.
LOPSIDED_DEFAULT_PANEL = BenchmarkPanel(
    panel_id="lopsided-default",
    members=[
        BenchmarkPanelMember(id="gpt", model="gpt-5.5", provider="openai"),
        BenchmarkPanelMember(id="sonnet", model="claude-sonnet-4-6", provider="anthropic"),
    ],
    judge_id="gpt",
    note="product default; lopsided (one member much stronger), low fusion headroom",
)

BENCHMARK_PANELS: dict[str, BenchmarkPanel] = {
    DECORRELATED_PEER_PANEL.panel_id: DECORRELATED_PEER_PANEL,
    LOPSIDED_DEFAULT_PANEL.panel_id: LOPSIDED_DEFAULT_PANEL,
}


def get_benchmark_panel(panel_id: str) -> BenchmarkPanel:
    try:
        return BENCHMARK_PANELS[panel_id]
    except KeyError as exc:
        known = ", ".join(sorted(BENCHMARK_PANELS))
        raise KeyError(f"unknown benchmark panel {panel_id!r}; known panels: {known}") from exc


__all__ = [
    "BENCHMARK_PANELS",
    "DECORRELATED_PEER_PANEL",
    "DEFAULT_PROVIDER_BASE_URLS",
    "DEFAULT_PROVIDER_KEY_ENVS",
    "LOPSIDED_DEFAULT_PANEL",
    "LOPSIDED_SCORE_GAP",
    "BenchmarkPanel",
    "BenchmarkPanelMember",
    "PanelHeadroom",
    "estimate_panel_headroom",
    "get_benchmark_panel",
]
