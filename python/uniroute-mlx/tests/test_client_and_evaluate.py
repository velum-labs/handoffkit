import numpy as np
import pytest

from uniroute_mlx import (
    EndpointError,
    Evaluation,
    Example,
    OpenAICompatibleClient,
    evaluate_model,
    load_evaluations,
    load_examples,
    save_evaluation,
    score,
)

from .fake_server import FakeOpenAIServer


def test_chat_embeddings_and_models_roundtrip():
    with FakeOpenAIServer(
        chat_models={"echo": lambda prompt: f"echo: {prompt}"}
    ) as server:
        client = OpenAICompatibleClient(server.base_url)
        result = client.chat("echo", "hello")
        assert result.text == "echo: hello"
        assert result.latency_s > 0

        matrix = client.embed("fake-embedder", ["math question", "code question"])
        assert matrix.shape == (2, server.dims)
        assert matrix[0, 0] == 1.0 and matrix[1, 1] == 1.0  # keyword axes

        assert "echo" in client.models()


def test_base_url_with_v1_suffix_is_accepted():
    with FakeOpenAIServer(chat_models={"echo": lambda p: p}) as server:
        client = OpenAICompatibleClient(server.base_url + "/v1/")
        assert client.chat("echo", "x").text == "x"


def test_unknown_model_raises_endpoint_error():
    with FakeOpenAIServer() as server:
        client = OpenAICompatibleClient(server.base_url)
        with pytest.raises(EndpointError, match="HTTP 404"):
            client.chat("missing", "x")


def test_unreachable_endpoint_raises_endpoint_error():
    client = OpenAICompatibleClient("http://127.0.0.1:1", timeout_s=0.5)
    with pytest.raises(EndpointError, match="unreachable"):
        client.chat("any", "x")


class TestScore:
    def test_exact_is_case_and_whitespace_insensitive(self):
        example = Example(prompt="p", target="Paris")
        assert score("  paris \n", example) == 0.0
        assert score("paris, france", example) == 1.0

    def test_contains(self):
        example = Example(prompt="p", target="Paris", match="contains")
        assert score("The capital is Paris.", example) == 0.0
        assert score("London", example) == 1.0

    def test_numeric_uses_last_number(self):
        example = Example(prompt="p", target="42", match="numeric")
        assert score("6 * 7 = 42", example) == 0.0
        assert score("the answer is 41", example) == 1.0
        assert score("no numbers here", example) == 1.0


def test_load_examples_validates(tmp_path):
    path = tmp_path / "val.jsonl"
    path.write_text('{"prompt": "p", "target": "t"}\n{"bad": true}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="needs 'prompt' and 'target'"):
        load_examples(path)


def test_evaluate_model_scores_and_persists(tmp_path):
    examples = [
        Example(prompt="math: 2+2", target="4", match="numeric"),
        Example(prompt="math: 3+3", target="6", match="numeric"),
        Example(prompt="code: print hi", target="print('hi')", match="contains"),
    ]
    with FakeOpenAIServer(
        chat_models={
            # Aces math, fails code.
            "math-llm": lambda prompt: "4" if "2+2" in prompt else ("6" if "3+3" in prompt else "???")
        }
    ) as server:
        client = OpenAICompatibleClient(server.base_url)
        evaluation = evaluate_model(client, "math-llm", examples)

    np.testing.assert_array_equal(evaluation.errors, [0.0, 0.0, 1.0])
    assert evaluation.error_rate == pytest.approx(1 / 3)
    assert evaluation.mean_latency_s > 0

    save_evaluation(evaluation, tmp_path)
    loaded = load_evaluations(tmp_path)
    assert len(loaded) == 1
    np.testing.assert_array_equal(loaded[0].errors, evaluation.errors)
    assert loaded[0].model == "math-llm"


def test_load_evaluations_rejects_mismatched_validation_sets(tmp_path):
    save_evaluation(
        Evaluation(model="a", errors=np.zeros(3), mean_latency_s=0.1), tmp_path
    )
    save_evaluation(
        Evaluation(model="b", errors=np.zeros(4), mean_latency_s=0.1), tmp_path
    )
    with pytest.raises(ValueError, match="different validation sets"):
        load_evaluations(tmp_path)
