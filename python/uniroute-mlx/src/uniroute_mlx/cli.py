"""The uniroute-mlx CLI: evaluate candidates, fit a router card, route.

    uniroute-mlx evaluate --endpoint URL --model ID [--model ID2 ...] \
        --val val.jsonl --out evals/

    uniroute-mlx fit --train-prompts train.jsonl --val val.jsonl --evals evals/ \
        --embed-endpoint URL --embed-model ID --clusters K --out card.json

    uniroute-mlx route --card card.json --embed-endpoint URL "prompt ..."

The endpoints are OpenAI-compatible servers -- e.g. the mlx-lm server the
repository's TypeScript `mlxServer` manages, or Ollama/LM Studio/a cloud
provider. Evaluation writes one resumable file per model, so adding a new
model to the pool re-evaluates only that model (the dynamic-pool property).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from uniroute import UniRouteKMeans

from .card import build_card, load_card, save_card
from .client import OpenAICompatibleClient
from .evaluate import (
    Evaluation,
    evaluate_model,
    load_evaluations,
    load_examples,
    save_evaluation,
)


def load_prompts(path: str | Path) -> list[str]:
    """Training prompts: JSONL objects with a 'prompt' key, or raw lines."""
    prompts: list[str] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            prompts.append(str(record["prompt"]) if isinstance(record, dict) else line)
        except json.JSONDecodeError:
            prompts.append(line)
    if not prompts:
        raise ValueError(f"{path}: no prompts")
    return prompts


def _embed_in_batches(
    client: OpenAICompatibleClient, model: str, texts: list[str], *, batch_size: int = 64
) -> np.ndarray:
    chunks = [
        client.embed(model, texts[i : i + batch_size])
        for i in range(0, len(texts), batch_size)
    ]
    return np.concatenate(chunks, axis=0)


def cmd_evaluate(args: argparse.Namespace) -> int:
    client = OpenAICompatibleClient(args.endpoint, api_key=args.api_key)
    examples = load_examples(args.val)
    out = Path(args.out)
    for model in args.model:
        target = out / (model.replace("/", "__") + ".json")
        if target.exists() and not args.force:
            print(f"skip {model}: {target} exists (use --force to re-evaluate)")
            continue
        print(f"evaluating {model} on {len(examples)} validation prompts...")
        evaluation = evaluate_model(
            client, model, examples, system=args.system, max_tokens=args.max_tokens
        )
        path = save_evaluation(evaluation, out)
        print(
            f"  error rate {evaluation.error_rate:.3f}, "
            f"mean latency {evaluation.mean_latency_s * 1000:.0f}ms -> {path}"
        )
    return 0


def _parse_cost_overrides(pairs: list[str]) -> dict[str, float]:
    overrides: dict[str, float] = {}
    for pair in pairs:
        model, _, value = pair.partition("=")
        if not model or not value:
            raise SystemExit(f"--cost expects MODEL=VALUE, got {pair!r}")
        overrides[model] = float(value)
    return overrides


def cmd_fit(args: argparse.Namespace) -> int:
    evaluations: list[Evaluation] = load_evaluations(args.evals)
    examples = load_examples(args.val)
    n_val = len(examples)
    for evaluation in evaluations:
        if evaluation.errors.shape[0] != n_val:
            raise SystemExit(
                f"evaluation for {evaluation.model} covers {evaluation.errors.shape[0]} "
                f"prompts but the validation set has {n_val}"
            )
    train_prompts = load_prompts(args.train_prompts)

    embed_client = OpenAICompatibleClient(args.embed_endpoint, api_key=args.api_key)
    print(f"embedding {len(train_prompts)} training prompts...")
    train_embeddings = _embed_in_batches(embed_client, args.embed_model, train_prompts)
    print(f"embedding {n_val} validation prompts...")
    val_embeddings = _embed_in_batches(
        embed_client, args.embed_model, [example.prompt for example in examples]
    )

    router = UniRouteKMeans(args.clusters, seed=args.seed).fit(train_embeddings)
    val_errors = np.stack([evaluation.errors for evaluation in evaluations], axis=1)
    psi = router.embed_llms(val_embeddings, val_errors)

    overrides = _parse_cost_overrides(args.cost)
    unknown = set(overrides) - {evaluation.model for evaluation in evaluations}
    if unknown:
        raise SystemExit(f"--cost overrides for models without evaluations: {sorted(unknown)}")
    costs = np.asarray(
        [
            overrides.get(evaluation.model, evaluation.mean_latency_s)
            for evaluation in evaluations
        ],
        dtype=np.float64,
    )

    card = build_card(
        router,
        psi,
        costs,
        [evaluation.model for evaluation in evaluations],
        embedder_model=args.embed_model,
        default_lambda=args.lam,
    )
    save_card(card, args.out)
    print(
        f"router card -> {args.out} "
        f"(K={args.clusters}, {len(evaluations)} models, embedder {args.embed_model})"
    )
    return 0


def cmd_route(args: argparse.Namespace) -> int:
    card = load_card(args.card)
    embed_client = OpenAICompatibleClient(args.embed_endpoint, api_key=args.api_key)
    embedding = embed_client.embed(card.embedder_model, [args.prompt])[0]
    decision = card.decide(embedding, lam=args.lam)
    print(f"route -> {decision.model_id}")
    print(
        f"  predicted error {decision.predicted_error:.3f}, "
        f"cost {decision.cost:.4f}, score {decision.score:.4f}"
    )
    for model, score in sorted(zip(card.models, decision.scores, strict=False), key=lambda t: t[1]):
        marker = "*" if model.model_id == decision.model_id else " "
        print(f"  {marker} {model.model_id:<40} score {score:.4f} cost {model.cost:.4f}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="uniroute-mlx", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    evaluate = sub.add_parser("evaluate", help="evaluate models over a validation JSONL")
    evaluate.add_argument("--endpoint", required=True, help="OpenAI-compatible base URL")
    evaluate.add_argument("--model", action="append", required=True, help="model id (repeatable)")
    evaluate.add_argument("--val", required=True, help="validation JSONL (prompt/target/match)")
    evaluate.add_argument("--out", required=True, help="directory for per-model eval files")
    evaluate.add_argument("--system", default=None, help="optional system prompt")
    evaluate.add_argument("--max-tokens", type=int, default=256)
    evaluate.add_argument("--api-key", default=None)
    evaluate.add_argument("--force", action="store_true", help="re-evaluate existing models")
    evaluate.set_defaults(fn=cmd_evaluate)

    fit = sub.add_parser("fit", help="fit a router card from prompts + evaluations")
    fit.add_argument("--train-prompts", required=True, help="JSONL or text file of prompts")
    fit.add_argument("--val", required=True, help="the validation JSONL used by evaluate")
    fit.add_argument("--evals", required=True, help="directory written by evaluate")
    fit.add_argument("--embed-endpoint", required=True, help="embeddings base URL")
    fit.add_argument("--embed-model", required=True, help="embedding model id")
    fit.add_argument("--clusters", type=int, required=True, help="number of clusters K")
    fit.add_argument("--out", required=True, help="router card output path")
    fit.add_argument("--lam", type=float, default=0.0, help="default lambda stored in the card")
    fit.add_argument("--seed", type=int, default=0)
    fit.add_argument(
        "--cost",
        action="append",
        default=[],
        metavar="MODEL=VALUE",
        help="override a model's cost (default: measured mean latency)",
    )
    fit.add_argument("--api-key", default=None)
    fit.set_defaults(fn=cmd_fit)

    route = sub.add_parser("route", help="route one prompt with a router card")
    route.add_argument("--card", required=True)
    route.add_argument("--embed-endpoint", required=True)
    route.add_argument("--lam", type=float, default=None, help="override the card's lambda")
    route.add_argument("--api-key", default=None)
    route.add_argument("prompt")
    route.set_defaults(fn=cmd_route)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
