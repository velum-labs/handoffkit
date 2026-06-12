"""Monkeypatches that teach the pinned mlx_lm.server structured decoding.

mlx-lm has no extension hooks for the server, so this overlay patches three
seams of the exact-pinned version (the pin is enforced in `server.py` before
anything here runs). All patches are method/attribute level, which keeps them
effective regardless of how mlx-lm binds its classes internally (e.g. the
def-time ``handler_class=APIHandler`` default argument):

1. ``APIHandler.handle_completion`` — parse and validate the structured
   output parameters from the request body; reject malformed ones with a 400;
   attach the parsed ConstraintSpec to the CompletionRequest.
2. ``ResponseGenerator.generate`` — move the spec from the request onto
   ``args.logits`` so it travels with the GenerationArguments through the
   request queue (and through pickling in distributed mode).
3. ``mlx_lm.server._make_logits_processors`` — the single choke point both
   the single-request path (``_serve_single``) and the continuous-batching
   path (``BatchGenerator.insert_segments``) use to build per-request logits
   processors: append a StructuredLogitsProcessor when a spec is present.

``ResponseGenerator.__init__`` is additionally wrapped to record the live
generator instance, because seam 3 only receives ``args`` and needs the
model provider's tokenizer and model key to build the FSM vocabulary.

The wrapper logic itself lives in `seams.py` (mlx-free and unit-tested);
this module only binds it to the real mlx_lm.server objects.
"""

from __future__ import annotations

import mlx_lm.server as mlx_server

from mlx_lm_structured.seams import (
    GeneratorHolder,
    make_generate_wrapper,
    make_handle_completion_wrapper,
    make_init_wrapper,
    make_logits_processors_wrapper,
)

ACTIVE_GENERATOR = GeneratorHolder()
_PATCHED = False


def apply_patches() -> None:
    """Apply all server patches (idempotent)."""
    global _PATCHED
    if _PATCHED:
        return
    _PATCHED = True

    mlx_server.ResponseGenerator.__init__ = make_init_wrapper(
        mlx_server.ResponseGenerator.__init__, ACTIVE_GENERATOR
    )
    mlx_server.APIHandler.handle_completion = make_handle_completion_wrapper(
        mlx_server.APIHandler.handle_completion
    )
    mlx_server.ResponseGenerator.generate = make_generate_wrapper(
        mlx_server.ResponseGenerator.generate
    )
    mlx_server._make_logits_processors = make_logits_processors_wrapper(
        mlx_server._make_logits_processors, ACTIVE_GENERATOR
    )
