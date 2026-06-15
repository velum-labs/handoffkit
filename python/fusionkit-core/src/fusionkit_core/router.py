from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from fusionkit_core.types import ChatMessage

RouteDecision = Literal["single", "self", "panel"]


@dataclass(frozen=True)
class RouterDecision:
    route: RouteDecision
    reasons: tuple[str, ...]


class HeuristicRouter:
    hard_keywords = frozenset(
        {
            "architecture",
            "benchmark",
            "compare",
            "contradiction",
            "deep research",
            "evaluate",
            "evidence",
            "legal",
            "medical",
            "pareto",
            "research",
            "sota",
            "verify",
        }
    )
    medium_keywords = frozenset(
        {
            "code",
            "debug",
            "explain",
            "math",
            "plan",
            "reason",
            "review",
            "tradeoff",
        }
    )

    def route(self, messages: Sequence[ChatMessage]) -> RouterDecision:
        user_text = " ".join(message.content for message in messages if message.role == "user").lower()
        reasons: list[str] = []
        if any(keyword in user_text for keyword in self.hard_keywords):
            reasons.append("hard keyword")
            return RouterDecision(route="panel", reasons=tuple(reasons))
        if len(user_text.split()) > 120:
            reasons.append("long prompt")
            return RouterDecision(route="panel", reasons=tuple(reasons))
        if any(keyword in user_text for keyword in self.medium_keywords):
            reasons.append("medium keyword")
            return RouterDecision(route="self", reasons=tuple(reasons))
        reasons.append("short simple prompt")
        return RouterDecision(route="single", reasons=tuple(reasons))
