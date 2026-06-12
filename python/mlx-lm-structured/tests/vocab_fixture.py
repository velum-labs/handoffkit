"""A tiny synthetic tokenizer shared by the tests (no HF download needed).

This lives outside conftest.py under a distinctive module name because the
uv workspace runs several members' test directories in one pytest session
and these constants are imported directly by test modules.
"""

from __future__ import annotations

from typing import Dict, List

# A deliberately small character-level-ish vocabulary that is rich enough to
# express small JSON documents and regexes. Multi-character tokens exercise
# the multi-token-per-string FSM paths.
TOKEN_STRINGS: List[str] = [
    "{",  # 0
    "}",  # 1
    '"',  # 2
    ":",  # 3
    ",",  # 4
    " ",  # 5
    "a",  # 6
    "b",  # 7
    "c",  # 8
    "0",  # 9
    "1",  # 10
    "2",  # 11
    "name",  # 12
    "age",  # 13
    "[",  # 14
    "]",  # 15
    "ab",  # 16
    "12",  # 17
    "x",  # 18
]
EOS_ID = 19
SECONDARY_EOS_ID = 20
VOCAB_SIZE = 21


class FakeTokenizer:
    """Mimics the slice of mlx-lm's TokenizerWrapper the overlay uses."""

    def __init__(self) -> None:
        self.eos_token_id = EOS_ID
        self.eos_token_ids = {EOS_ID, SECONDARY_EOS_ID}
        self._vocab: Dict[str, int] = {s: i for i, s in enumerate(TOKEN_STRINGS)}
        self._vocab["</s>"] = EOS_ID
        self._vocab["<|stop|>"] = SECONDARY_EOS_ID

    def get_vocab(self) -> Dict[str, int]:
        return dict(self._vocab)

    def convert_tokens_to_string(self, tokens: List[str]) -> str:
        return "".join(tokens)
