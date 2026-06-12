import pytest

from vocab_fixture import FakeTokenizer


@pytest.fixture
def tokenizer() -> FakeTokenizer:
    return FakeTokenizer()
