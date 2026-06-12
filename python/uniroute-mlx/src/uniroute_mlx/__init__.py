"""UniRoute for locally served models (mlx-lm and any OpenAI-compatible API).

The `uniroute` package owns all the routing math; this package is the bridge
to running models: evaluate candidates over a validation set through their
OpenAI-compatible endpoints, fit a router, and freeze it into a portable
``uniroute.router.v1`` card that any runtime (including the repository's
TypeScript ``routedModel``) can route with.
"""

from .card import RouterCard, build_card, load_card, save_card
from .client import ChatResult, EndpointError, OpenAICompatibleClient
from .evaluate import (
    Evaluation,
    Example,
    evaluate_model,
    load_evaluations,
    load_examples,
    save_evaluation,
    score,
)

__all__ = [
    "ChatResult",
    "EndpointError",
    "Evaluation",
    "Example",
    "OpenAICompatibleClient",
    "RouterCard",
    "build_card",
    "evaluate_model",
    "load_card",
    "load_evaluations",
    "load_examples",
    "save_card",
    "save_evaluation",
    "score",
]
