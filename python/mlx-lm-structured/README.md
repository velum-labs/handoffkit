# mlx-lm-structured

Constrained/structured decoding overlay for `mlx_lm.server`, built on
[outlines-core](https://github.com/dottxt-ai/outlines-core). It makes the
OpenAI-compatible MLX server honor structured-output request parameters by
masking logits with a compiled FSM so the model can only emit tokens that
keep the output valid.

## Usage

```sh
pip install mlx-lm-structured[server]   # pulls the pinned mlx-lm
python -m mlx_lm_structured.server --model mlx-community/Qwen2.5-0.5B-Instruct-4bit
```

`python -m mlx_lm_structured.server` accepts exactly the same CLI flags as
`python -m mlx_lm server`; it applies its patches and delegates to the
original entry point. The overlay targets one exact-pinned mlx-lm version
(see `EXPECTED_MLX_LM_VERSION` in `server.py`) and refuses to start against
any other, since it patches internal seams.

## Request parameters

On `/v1/chat/completions` and `/v1/completions`:

| Field | Form | Meaning |
| --- | --- | --- |
| `response_format` | `{"type": "json_schema", "json_schema": {"schema": {...}}}` | Output is valid JSON matching the schema (OpenAI structured outputs) |
| `response_format` | `{"type": "json_object"}` | Output is a valid JSON object |
| `guided_json` | schema dict or JSON string | vLLM-style alias for a JSON schema constraint |
| `guided_regex` | regex string | Output matches the regex |
| `guided_choice` | list of strings | Output is exactly one of the choices |

At most one constraint may be supplied per request; malformed constraints are
rejected with HTTP 400. Constrained requests work with streaming and
non-streaming responses, with the server's continuous batching, and with
speculative decoding (the processor rolls its FSM back when draft tokens are
rejected).

## Caveats

- The constraint applies from the first generated token. For reasoning
  ("thinking") models, disable thinking for constrained requests (e.g.
  `"chat_template_kwargs": {"enable_thinking": false}`), otherwise the
  `<think>` preamble itself is forced into the constrained shape.
- The first request for a new schema compiles a regex/FSM index (~0.1 s for
  small schemas, more for complex ones). Compiled indexes are cached per
  (model, constraint); the tokenizer vocabulary is processed once per model
  (~0.3 s for a 150k vocabulary).
- Regex features outside the FSM subset (lookarounds, backreferences) are
  rejected with HTTP 400.
- JSON schema support is whatever `outlines_core.json_schema` supports;
  unsupported schema constructs are rejected with HTTP 400.

## Development

The package logic is testable without Apple Silicon: the test suite drives
the processor through the numpy kernel backend (`numba` required, declared as
a dev dependency).

```sh
uv run pytest python/mlx-lm-structured/tests
```
