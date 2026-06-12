"""Evaluate candidate models over a labelled validation set.

This produces the prediction error vector of S 4.2 of the paper for each
candidate: one pass over a small validation JSONL per model, scored with a
simple per-example match rule. The measured mean latency doubles as the
default per-prompt cost (a meaningful local cost where API prices do not
exist); callers can override the cost per model when building a router card.

Validation JSONL: one object per line --

    {"prompt": "...", "target": "...", "match": "exact" | "contains" | "numeric"}

``match`` defaults to "exact". Evaluations are written one JSON file per
model (``uniroute.eval.v1``), so a long pool evaluation is resumable and a
new model never forces re-running the others -- the dynamic-pool property.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .client import OpenAICompatibleClient

EVAL_VERSION = "uniroute.eval.v1"

MatchRule = str  # "exact" | "contains" | "numeric"
_VALID_RULES = ("exact", "contains", "numeric")

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


@dataclass(frozen=True)
class Example:
    prompt: str
    target: str
    match: MatchRule = "exact"


@dataclass(frozen=True)
class Evaluation:
    """One model's pass over the validation set."""

    model: str
    errors: np.ndarray  # (n_examples,) 0-1 losses
    mean_latency_s: float

    @property
    def error_rate(self) -> float:
        return float(self.errors.mean())


def load_examples(path: str | Path) -> list[Example]:
    examples: list[Example] = []
    for line_no, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_no}: not valid JSON") from error
        if not isinstance(record, dict) or "prompt" not in record or "target" not in record:
            raise ValueError(f"{path}:{line_no}: each line needs 'prompt' and 'target'")
        match = record.get("match", "exact")
        if match not in _VALID_RULES:
            raise ValueError(f"{path}:{line_no}: match must be one of {_VALID_RULES}")
        examples.append(
            Example(prompt=str(record["prompt"]), target=str(record["target"]), match=match)
        )
    if not examples:
        raise ValueError(f"{path}: no examples")
    return examples


def score(output: str, example: Example) -> float:
    """0-1 loss of a model output against one example (1 = wrong)."""
    if example.match == "exact":
        return 0.0 if output.strip().casefold() == example.target.strip().casefold() else 1.0
    if example.match == "contains":
        return 0.0 if example.target.strip().casefold() in output.casefold() else 1.0
    if example.match == "numeric":
        found = _NUMBER.findall(output)
        if not found:
            return 1.0
        try:
            return 0.0 if abs(float(found[-1]) - float(example.target)) <= 1e-6 else 1.0
        except ValueError:
            return 1.0
    raise ValueError(f"unknown match rule: {example.match}")


def evaluate_model(
    client: OpenAICompatibleClient,
    model: str,
    examples: list[Example],
    *,
    system: str | None = None,
    max_tokens: int = 256,
) -> Evaluation:
    """One pass: ask the model every validation prompt and score it."""
    errors = np.empty(len(examples), dtype=np.float64)
    latencies = np.empty(len(examples), dtype=np.float64)
    for i, example in enumerate(examples):
        result = client.chat(model, example.prompt, system=system, max_tokens=max_tokens)
        errors[i] = score(result.text, example)
        latencies[i] = result.latency_s
    return Evaluation(model=model, errors=errors, mean_latency_s=float(latencies.mean()))


def _eval_path(directory: Path, model: str) -> Path:
    # Model ids contain '/' (HF repos); keep one flat file per model.
    return directory / (model.replace("/", "__") + ".json")


def save_evaluation(evaluation: Evaluation, directory: str | Path) -> Path:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = _eval_path(directory, evaluation.model)
    path.write_text(
        json.dumps(
            {
                "version": EVAL_VERSION,
                "model": evaluation.model,
                "errors": evaluation.errors.tolist(),
                "meanLatencyS": evaluation.mean_latency_s,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def load_evaluations(directory: str | Path) -> list[Evaluation]:
    """Every ``uniroute.eval.v1`` file in a directory, sorted by model id."""
    evaluations: list[Evaluation] = []
    for path in sorted(Path(directory).glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("version") != EVAL_VERSION:
            raise ValueError(f"{path}: expected version {EVAL_VERSION}")
        evaluations.append(
            Evaluation(
                model=str(record["model"]),
                errors=np.asarray(record["errors"], dtype=np.float64),
                mean_latency_s=float(record["meanLatencyS"]),
            )
        )
    if not evaluations:
        raise ValueError(f"{directory}: no evaluation files")
    lengths = {evaluation.errors.shape[0] for evaluation in evaluations}
    if len(lengths) > 1:
        raise ValueError(
            f"{directory}: evaluations cover different validation sets (sizes {sorted(lengths)})"
        )
    return sorted(evaluations, key=lambda evaluation: evaluation.model)
