"""The per-request logits processor that enforces a compiled constraint.

mlx-lm's contract for logits processors is ``(tokens, logits) -> logits``
where ``tokens`` is the full token history (prompt + generated so far) and
``logits`` has shape ``(1, vocab_size)``. The same processor instance is
called from three code paths with the same contract but different history
behavior:

- single-request ``generate_step``: history grows by one token per call;
- ``BatchGenerator._step``: history is this sequence's full context, also
  growing by one per call;
- ``speculative_generate_step``: history is shared between the draft and the
  main model and is *rewound* when draft tokens are rejected, so consecutive
  calls may disagree about the recent past.

Instead of assuming append-only history, the processor resyncs the FSM Guide
against the observed history on every call: it tracks the tokens the guide
has consumed, finds the longest common prefix with what the history now says,
rolls the guide back over the disagreement (outlines-core Guides support
bounded rollback), and advances through the new suffix. If a rewind exceeds
the rollback capacity the guide is reset and replayed from the constraint
start — correct in all cases, merely slower.
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence

from outlines_core import Guide, Index

from mlx_lm_structured.backends import Backend, get_backend

# Covers default num_draft_tokens (a few) with a wide margin; beyond this the
# guide falls back to reset-and-replay.
ROLLBACK_CAPACITY = 64


class StructuredLogitsProcessor:
    """Masks logits so generation can only follow the compiled constraint."""

    def __init__(
        self,
        index: Index,
        eos_token_ids: Sequence[int],
        backend: Optional[Backend] = None,
    ):
        self._index = index
        self._guide = Guide(index, ROLLBACK_CAPACITY)
        self._eos_token_ids = list(eos_token_ids)
        self._backend = backend if backend is not None else get_backend()
        # History length (prompt included) at which the constraint starts.
        self._start: Optional[int] = None
        # Tokens the guide has consumed since the constraint start.
        self._consumed: List[int] = []
        # Set once the history contains an EOS (or a token the guide cannot
        # consume): from then on only EOS remains unmasked.
        self._done = False
        self._mask = None
        self._keep_eos = None

    # ---- guide synchronization ----

    def _replay(self, generated: List[int]) -> None:
        self._guide.reset()
        self._consumed = []
        self._done = False
        self._advance_through(generated)

    def _advance_through(self, new_tokens: List[int]) -> None:
        for token in new_tokens:
            if self._done:
                return
            if token in self._eos_token_ids:
                self._done = True
                return
            try:
                self._guide.advance(token_id=token, return_tokens=False)
            except ValueError:
                # The history contains a token the FSM cannot consume. This
                # should not happen while this processor is masking, but other
                # processors or samplers are outside our control; degrade to
                # forcing EOS rather than crashing the generation thread.
                self._done = True
                return
            self._consumed.append(token)

    def _resync(self, generated: List[int]) -> None:
        common = 0
        limit = min(len(self._consumed), len(generated))
        while common < limit and self._consumed[common] == generated[common]:
            common += 1
        excess = len(self._consumed) - common

        if excess > 0:
            if excess > self._guide.get_allowed_rollback():
                self._replay(generated)
                return
            self._guide.rollback_state(excess)
            del self._consumed[common:]
        # The done flag describes the suffix beyond `common`; that suffix is
        # re-walked below, so it is rederived from scratch (a rewound EOS must
        # un-finish the processor).
        self._done = False
        self._advance_through(generated[common:])

    # ---- mlx-lm logits processor interface ----

    def __call__(self, tokens: Any, logits: Any) -> Any:
        history = self._backend.to_int_list(tokens)

        if self._start is None:
            # First call: everything seen so far is prompt; the constraint
            # applies from the next sampled token onward.
            self._start = len(history)
        elif len(history) < self._start:
            # The engine rewound past the constraint start (cannot happen in
            # current mlx-lm, but cheap to make correct): restart there.
            self._start = len(history)
            self._replay([])
        else:
            self._resync(history[self._start :])

        vocab_size = logits.shape[-1]
        if self._done:
            if self._keep_eos is None:
                self._keep_eos = self._backend.make_keep_mask(
                    vocab_size, self._eos_token_ids
                )
            return self._backend.apply_keep(logits, self._keep_eos)

        if self._mask is None:
            self._mask = self._backend.allocate_mask(vocab_size)
        self._backend.fill_mask(self._guide, self._mask)
        return self._backend.apply_mask(logits, self._mask)
