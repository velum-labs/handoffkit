"""The router card: a fitted UniRoute router as a portable JSON artifact.

A fitted router is pure data -- the cluster assignment map plus each model's
per-cluster error vector Psi and cost. ``uniroute.router.v1`` captures
exactly that, so the online routing rule (embed, assign, cost-adjusted
argmin) can run anywhere: this package's CLI, the repository's TypeScript
``routedModel``, or anything else that can read JSON.

Two assignment map types mirror the two UniRoute instantiations:

- ``centroids``: hard nearest-centroid assignment (S 5.1, UniRouteKMeans).
- ``softmax``:   learned soft assignment softmax(theta . [x, 1]) (S 5.2,
                 UniRouteLearnedMap; theta's trailing column is the bias).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from uniroute import UniRouteKMeans, UniRouteLearnedMap
from uniroute.routers import route as plugin_route

CARD_VERSION = "uniroute.router.v1"


@dataclass(frozen=True)
class CardModel:
    """One routable candidate: id, per-cluster errors, per-prompt cost."""

    model_id: str
    psi: np.ndarray  # (n_clusters,)
    cost: float


@dataclass(frozen=True)
class RouteDecision:
    """The routed choice plus everything needed to explain it."""

    model_id: str
    cluster_weights: np.ndarray  # (n_clusters,)
    predicted_error: float
    cost: float
    score: float
    # Cost-adjusted score per candidate, aligned with the card's model order.
    scores: np.ndarray


@dataclass(frozen=True)
class RouterCard:
    embedder_model: str
    dims: int
    default_lambda: float
    assignment_type: str  # "centroids" | "softmax"
    # centroids: (K, dims); softmax theta: (K, dims + 1) with bias column.
    assignment: np.ndarray
    models: list[CardModel]

    @property
    def n_clusters(self) -> int:
        return self.assignment.shape[0]

    def psi_matrix(self) -> np.ndarray:
        """(n_models, n_clusters), row order = self.models order."""
        return np.stack([model.psi for model in self.models])

    def costs(self) -> np.ndarray:
        return np.asarray([model.cost for model in self.models], dtype=np.float64)

    def cluster_weights(self, embedding: np.ndarray) -> np.ndarray:
        """Phi(x): one-hot nearest centroid, or the learned softmax."""
        embedding = np.asarray(embedding, dtype=np.float64)
        if embedding.shape != (self.dims,):
            raise ValueError(f"embedding must have shape ({self.dims},), got {embedding.shape}")
        if self.assignment_type == "centroids":
            distances = np.einsum(
                "kd,kd->k",
                self.assignment - embedding[None, :],
                self.assignment - embedding[None, :],
            )
            weights = np.zeros(self.n_clusters, dtype=np.float64)
            weights[int(distances.argmin())] = 1.0
            return weights
        if self.assignment_type == "softmax":
            features = np.concatenate([embedding, [1.0]])
            logits = self.assignment @ features
            shifted = logits - logits.max()
            exp = np.exp(shifted)
            return exp / exp.sum()
        raise ValueError(f"unknown assignment type: {self.assignment_type}")

    def decide(self, embedding: np.ndarray, *, lam: float | None = None) -> RouteDecision:
        """The plug-in rule (eq. 9) for one prompt embedding."""
        lam = self.default_lambda if lam is None else lam
        weights = self.cluster_weights(embedding)
        gamma = self.psi_matrix() @ weights  # (n_models,)
        costs = self.costs()
        choice = int(plugin_route(gamma[None, :], costs, lam)[0])
        scores = gamma + lam * costs
        return RouteDecision(
            model_id=self.models[choice].model_id,
            cluster_weights=weights,
            predicted_error=float(gamma[choice]),
            cost=float(costs[choice]),
            score=float(scores[choice]),
            scores=scores,
        )


def build_card(
    router: UniRouteKMeans | UniRouteLearnedMap,
    psi: np.ndarray,
    costs: np.ndarray,
    model_ids: list[str],
    *,
    embedder_model: str,
    default_lambda: float = 0.0,
) -> RouterCard:
    """Freeze a fitted router + LLM embeddings into a portable card.

    ``psi`` is what the router's ``embed_llms`` returned for the candidate
    pool, ``costs``/``model_ids`` align with its rows.
    """
    psi = np.asarray(psi, dtype=np.float64)
    costs = np.asarray(costs, dtype=np.float64)
    if psi.shape[0] != len(model_ids) or costs.shape[0] != len(model_ids):
        raise ValueError("psi rows, costs, and model_ids must align")
    if isinstance(router, UniRouteKMeans):
        assignment_type = "centroids"
        assignment = router.centroids
        dims = router.centroids.shape[1]
    elif isinstance(router, UniRouteLearnedMap):
        assignment_type = "softmax"
        assignment = router.theta
        dims = router.theta.shape[1] - 1  # trailing bias column
    else:
        raise TypeError(f"unsupported router type: {type(router).__name__}")
    if psi.shape[1] != assignment.shape[0]:
        raise ValueError("psi columns must match the router's cluster count")
    return RouterCard(
        embedder_model=embedder_model,
        dims=dims,
        default_lambda=float(default_lambda),
        assignment_type=assignment_type,
        assignment=np.asarray(assignment, dtype=np.float64),
        models=[
            CardModel(model_id=model_ids[m], psi=psi[m], cost=float(costs[m]))
            for m in range(len(model_ids))
        ],
    )


def save_card(card: RouterCard, path: str | Path) -> None:
    payload = {
        "version": CARD_VERSION,
        "embedder": {"model": card.embedder_model, "dims": card.dims},
        "lambda": card.default_lambda,
        "assignment": {
            "type": card.assignment_type,
            ("centroids" if card.assignment_type == "centroids" else "theta"):
                card.assignment.tolist(),
        },
        "models": [
            {"id": model.model_id, "psi": model.psi.tolist(), "cost": model.cost}
            for model in card.models
        ],
    }
    Path(path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def load_card(path: str | Path) -> RouterCard:
    record = json.loads(Path(path).read_text(encoding="utf-8"))
    if record.get("version") != CARD_VERSION:
        raise ValueError(f"{path}: expected version {CARD_VERSION}")
    assignment_record = record["assignment"]
    assignment_type = assignment_record["type"]
    if assignment_type == "centroids":
        assignment = np.asarray(assignment_record["centroids"], dtype=np.float64)
        dims = assignment.shape[1]
    elif assignment_type == "softmax":
        assignment = np.asarray(assignment_record["theta"], dtype=np.float64)
        dims = assignment.shape[1] - 1
    else:
        raise ValueError(f"{path}: unknown assignment type {assignment_type!r}")
    declared_dims = int(record["embedder"]["dims"])
    if declared_dims != dims:
        raise ValueError(
            f"{path}: embedder dims {declared_dims} do not match the assignment map ({dims})"
        )
    models = [
        CardModel(
            model_id=str(item["id"]),
            psi=np.asarray(item["psi"], dtype=np.float64),
            cost=float(item["cost"]),
        )
        for item in record["models"]
    ]
    if not models:
        raise ValueError(f"{path}: card has no models")
    n_clusters = assignment.shape[0]
    for model in models:
        if model.psi.shape != (n_clusters,):
            raise ValueError(
                f"{path}: model {model.model_id} psi has shape {model.psi.shape}, "
                f"expected ({n_clusters},)"
            )
    return RouterCard(
        embedder_model=str(record["embedder"]["model"]),
        dims=dims,
        default_lambda=float(record.get("lambda", 0.0)),
        assignment_type=assignment_type,
        assignment=assignment,
        models=models,
    )
