"""End-to-end CLI flow against the fake server: evaluate -> fit -> route.

Mirrors the real MLX workflow exactly -- the only difference is that the
OpenAI-compatible endpoint is an in-process fake instead of `mlx_lm server`.
"""

import json

import pytest
from uniroute_mlx import load_card
from uniroute_mlx.cli import main

from .fake_server import FakeOpenAIServer

MATH_PROMPTS = [f"math: what is {i} + {i}?" for i in range(30)]
CODE_PROMPTS = [f"code: write snippet number {i}" for i in range(30)]


def make_server() -> FakeOpenAIServer:
    return FakeOpenAIServer(
        chat_models={
            # The specialist answers its own topic correctly, fails the other.
            "math-llm": lambda p: "correct" if "math" in p else "wrong",
            "code-llm": lambda p: "correct" if "code" in p else "wrong",
        },
        embed_keywords=["math", "code"],
    )


def write_fixtures(tmp_path):
    val = tmp_path / "val.jsonl"
    lines = [
        json.dumps({"prompt": prompt, "target": "correct", "match": "contains"})
        for prompt in MATH_PROMPTS[:10] + CODE_PROMPTS[:10]
    ]
    val.write_text("\n".join(lines) + "\n", encoding="utf-8")

    train = tmp_path / "train.jsonl"
    train.write_text(
        "\n".join(json.dumps({"prompt": p}) for p in MATH_PROMPTS[10:] + CODE_PROMPTS[10:])
        + "\n",
        encoding="utf-8",
    )
    return val, train


def test_evaluate_fit_route_flow(tmp_path, capsys):
    val, train = write_fixtures(tmp_path)
    evals = tmp_path / "evals"
    card_path = tmp_path / "card.json"

    with make_server() as server:
        assert (
            main(
                [
                    "evaluate",
                    "--endpoint", server.base_url,
                    "--model", "math-llm",
                    "--model", "code-llm",
                    "--val", str(val),
                    "--out", str(evals),
                ]
            )
            == 0
        )
        # Resumable: a second run skips both models.
        assert main(
            [
                "evaluate",
                "--endpoint", server.base_url,
                "--model", "math-llm",
                "--model", "code-llm",
                "--val", str(val),
                "--out", str(evals),
            ]
        ) == 0
        out = capsys.readouterr().out
        assert out.count("skip") == 2

        assert (
            main(
                [
                    "fit",
                    "--train-prompts", str(train),
                    "--val", str(val),
                    "--evals", str(evals),
                    "--embed-endpoint", server.base_url,
                    "--embed-model", "fake-embedder",
                    "--clusters", "2",
                    "--out", str(card_path),
                    "--cost", "math-llm=1.0",
                    "--cost", "code-llm=1.0",
                ]
            )
            == 0
        )

        card = load_card(card_path)
        assert card.embedder_model == "fake-embedder"
        assert [m.model_id for m in card.models] == ["code-llm", "math-llm"]
        # Each specialist is near-perfect on its own cluster, hopeless on the
        # other; the per-cluster errors must reflect that separation.
        for model in card.models:
            assert sorted(model.psi.tolist()) == pytest.approx([0.0, 1.0])

        assert (
            main(
                [
                    "route",
                    "--card", str(card_path),
                    "--embed-endpoint", server.base_url,
                    "math: what is 7 + 7?",
                ]
            )
            == 0
        )
        out = capsys.readouterr().out
        assert "route -> math-llm" in out

        assert (
            main(
                [
                    "route",
                    "--card", str(card_path),
                    "--embed-endpoint", server.base_url,
                    "code: write a loop",
                ]
            )
            == 0
        )
        assert "route -> code-llm" in capsys.readouterr().out


def test_fit_rejects_eval_validation_size_mismatch(tmp_path):
    val, train = write_fixtures(tmp_path)
    evals = tmp_path / "evals"

    with make_server() as server:
        main(
            [
                "evaluate",
                "--endpoint", server.base_url,
                "--model", "math-llm",
                "--val", str(val),
                "--out", str(evals),
            ]
        )
        # Shrink the validation set after evaluation: fit must refuse.
        smaller = tmp_path / "val-small.jsonl"
        smaller.write_text(
            val.read_text(encoding="utf-8").splitlines()[0] + "\n", encoding="utf-8"
        )
        with pytest.raises(SystemExit, match="validation set has 1"):
            main(
                [
                    "fit",
                    "--train-prompts", str(train),
                    "--val", str(smaller),
                    "--evals", str(evals),
                    "--embed-endpoint", server.base_url,
                    "--embed-model", "fake-embedder",
                    "--clusters", "2",
                    "--out", str(tmp_path / "card.json"),
                ]
            )


def test_measured_latency_is_default_cost(tmp_path):
    val, train = write_fixtures(tmp_path)
    evals = tmp_path / "evals"
    card_path = tmp_path / "card.json"

    with make_server() as server:
        main(
            [
                "evaluate",
                "--endpoint", server.base_url,
                "--model", "math-llm",
                "--val", str(val),
                "--out", str(evals),
            ]
        )
        main(
            [
                "fit",
                "--train-prompts", str(train),
                "--val", str(val),
                "--evals", str(evals),
                "--embed-endpoint", server.base_url,
                "--embed-model", "fake-embedder",
                "--clusters", "2",
                "--out", str(card_path),
            ]
        )
    card = load_card(card_path)
    assert card.models[0].cost > 0  # measured latency, not a placeholder
