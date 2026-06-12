import json

import numpy as np
import pytest

from mlx_lm_structured.backends import get_backend
from mlx_lm_structured.compile import IndexCache
from mlx_lm_structured.processor import StructuredLogitsProcessor
from mlx_lm_structured.spec import ConstraintSpec

from .conftest import EOS_ID, SECONDARY_EOS_ID, VOCAB_SIZE, TOKEN_STRINGS

TOKEN_IDS = {s: i for i, s in enumerate(TOKEN_STRINGS)}
MODEL_KEY = ("test-model", None, None)

PROMPT = [TOKEN_IDS["x"], TOKEN_IDS["x"], TOKEN_IDS["x"]]


@pytest.fixture
def cache():
    return IndexCache()


def make_processor(cache, tokenizer, kind, payload):
    spec = ConstraintSpec(kind=kind, payload=payload)
    index, _, eos_ids = cache.index(MODEL_KEY, tokenizer, spec)
    return StructuredLogitsProcessor(index, eos_ids, backend=get_backend("numpy"))


def allowed(processor, history):
    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    out = processor(np.array(history, dtype=np.int64), logits)
    return set(np.flatnonzero(out[0] > -np.inf).tolist())


def test_regex_walk_append_only(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "abc")
    first = allowed(processor, PROMPT)
    # 'a' or the multi-char token 'ab' start the match.
    assert first == {TOKEN_IDS["a"], TOKEN_IDS["ab"]}
    after_a = allowed(processor, PROMPT + [TOKEN_IDS["a"]])
    assert after_a == {TOKEN_IDS["b"]}
    after_ab = allowed(processor, PROMPT + [TOKEN_IDS["a"], TOKEN_IDS["b"]])
    assert after_ab == {TOKEN_IDS["c"]}
    done = allowed(processor, PROMPT + [TOKEN_IDS["a"], TOKEN_IDS["b"], TOKEN_IDS["c"]])
    # The match is complete: only the primary EOS remains.
    assert done == {EOS_ID}


def test_multichar_token_path(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "abc")
    allowed(processor, PROMPT)
    after_ab_token = allowed(processor, PROMPT + [TOKEN_IDS["ab"]])
    assert after_ab_token == {TOKEN_IDS["c"]}


def test_constraint_starts_after_prompt(cache, tokenizer):
    # The prompt may contain tokens that would be illegal inside the
    # constraint ('x' never matches "abc"); they must be ignored.
    processor = make_processor(cache, tokenizer, "regex", "abc")
    assert TOKEN_IDS["a"] in allowed(processor, PROMPT)


def test_eos_in_history_masks_all_eos_only(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "abc")
    allowed(processor, PROMPT)
    full = PROMPT + [TOKEN_IDS["a"], TOKEN_IDS["b"], TOKEN_IDS["c"], EOS_ID]
    assert allowed(processor, full) == {EOS_ID, SECONDARY_EOS_ID}


def test_unconsumable_token_degrades_to_eos(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "abc")
    allowed(processor, PROMPT)
    # 'x' cannot be consumed by the FSM; the processor must not crash and
    # should force EOS from here on.
    assert allowed(processor, PROMPT + [TOKEN_IDS["x"]]) == {
        EOS_ID,
        SECONDARY_EOS_ID,
    }


def test_speculative_rewind_resync(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "a(b|c)c")
    base = PROMPT + [TOKEN_IDS["a"]]
    allowed(processor, PROMPT)
    assert allowed(processor, base) == {TOKEN_IDS["b"], TOKEN_IDS["c"]}
    # Draft speculates 'b' then 'c'; both get masks.
    assert allowed(processor, base + [TOKEN_IDS["b"]]) == {TOKEN_IDS["c"]}
    assert allowed(processor, base + [TOKEN_IDS["b"], TOKEN_IDS["c"]]) == {EOS_ID}
    # The draft 'b' is rejected; the engine rewinds and takes 'c' instead.
    assert allowed(processor, base + [TOKEN_IDS["c"]]) == {TOKEN_IDS["c"]}
    assert allowed(processor, base + [TOKEN_IDS["c"], TOKEN_IDS["c"]]) == {EOS_ID}


def test_rewound_eos_unfinishes(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "ab?")
    allowed(processor, PROMPT)
    done = allowed(processor, PROMPT + [TOKEN_IDS["a"], EOS_ID])
    assert done == {EOS_ID, SECONDARY_EOS_ID}
    # The speculated EOS is rejected; 'b' is still a legal continuation.
    after_rewind = allowed(processor, PROMPT + [TOKEN_IDS["a"], TOKEN_IDS["b"]])
    assert after_rewind == {EOS_ID}


def test_rollback_overflow_falls_back_to_replay(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "a*bc")
    allowed(processor, PROMPT)
    long_run = [TOKEN_IDS["a"]] * 100
    assert TOKEN_IDS["b"] in allowed(processor, PROMPT + long_run)
    # Rewind 80 tokens — far beyond the guide's rollback capacity — and
    # diverge; the processor must replay and still produce correct masks.
    rewound = PROMPT + [TOKEN_IDS["a"]] * 20 + [TOKEN_IDS["b"]]
    assert allowed(processor, rewound) == {TOKEN_IDS["c"]}


def test_batch_shape_2d_tokens(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "ab")
    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    out = processor(np.array([PROMPT], dtype=np.int64), logits)
    assert set(np.flatnonzero(out[0] > -np.inf).tolist()) == {
        TOKEN_IDS["a"],
        TOKEN_IDS["ab"],
    }


def test_json_schema_end_to_end_greedy(cache, tokenizer):
    schema = json.dumps(
        {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
            "additionalProperties": False,
        }
    )
    processor = make_processor(cache, tokenizer, "json_schema", schema)

    target = '{"name": "ab"}'
    history = list(PROMPT)
    emitted = ""
    for _ in range(40):
        allowed_ids = allowed(processor, history)
        if emitted == target:
            assert allowed_ids == {EOS_ID}
            break
        remaining = target[len(emitted) :]
        # Stand-in for the model: longest allowed token continuing the target.
        token_id = max(
            (
                tid
                for tid in allowed_ids
                if tid < len(TOKEN_STRINGS) and remaining.startswith(TOKEN_STRINGS[tid])
            ),
            key=lambda tid: len(TOKEN_STRINGS[tid]),
            default=None,
        )
        assert token_id is not None, f"constraint blocked target at {emitted!r}"
        history.append(token_id)
        emitted += TOKEN_STRINGS[token_id]
    else:
        pytest.fail("did not finish the target document")
    assert json.loads(emitted) == {"name": "ab"}


def test_does_not_mutate_input_logits(cache, tokenizer):
    processor = make_processor(cache, tokenizer, "regex", "ab")
    logits = np.zeros((1, VOCAB_SIZE), dtype=np.float32)
    processor(np.array(PROMPT, dtype=np.int64), logits)
    assert np.all(logits == 0.0)
