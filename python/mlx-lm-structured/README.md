# mlx-lm-structured

Constrained/structured decoding for the [mlx-lm](https://github.com/ml-explore/mlx-lm)
OpenAI-compatible server, built on
[outlines-core](https://github.com/dottxt-ai/outlines-core). The output is
constrained by masking logits with a compiled FSM so the model can only emit
tokens that keep the output valid.

This package holds the constraint machinery: request-parameter parsing, JSON
schema/regex/choice compilation with caching, and the per-request logits
processor. The server-side hooks live in the
[velum-labs/mlx-lm](https://github.com/velum-labs/mlx-lm) fork (branch
`structured-0.31.3`, a minimal delta on the upstream `v0.31.3` tag): the fork
imports `mlx_lm_structured.integration` *optionally*, so it behaves exactly
like upstream when this package is absent, and enforces structured output
when it is installed.

## Usage

```sh
pip install "mlx-lm @ git+https://github.com/velum-labs/mlx-lm@structured-0.31.3"
pip install <path-to>/mlx-lm-structured
python -m mlx_lm server --model mlx-community/Qwen2.5-0.5B-Instruct-4bit
```

In this repository, `mlxServer({ structured: true })` from
`@warrant/adapter-ai-sdk` provisions exactly this pairing into the owned env.

## Request parameters

On `/v1/chat/completions` and `/v1/completions`:

| Field | Form | Meaning |
| --- | --- | --- |
| `response_format` | `{"type": "json_schema", "json_schema": {"schema": {...}}}` | Output is valid JSON matching the schema (OpenAI structured outputs) |
| `response_format` | `{"type": "json_object"}` | Output is a valid JSON object |
| `guided_json` | schema dict or JSON string | vLLM-style alias for a JSON schema constraint |
| `guided_regex` | regex string | Output matches the regex |
| `guided_choice` | list of strings | Output is exactly one of the choices |

At most one constraint may be supplied per request; malformed or
uncompilable constraints are rejected with HTTP 400 at request time.
Constrained requests work with streaming and non-streaming responses, with
the server's continuous batching, and with speculative decoding (the
processor rolls its FSM back when draft tokens are rejected).

## Integration surface

The fork consumes two functions from `mlx_lm_structured.integration`:

- `parse_request_constraint(body) -> ConstraintSpec | None` — HTTP-thread
  parsing and full validation; raises `ValueError` for the server's 400.
- `make_constraint_processor(spec, tokenizer, model_key)` — generation-thread
  factory returning a fresh single-request processor; FSM indexes are cached
  per (model, constraint) and the vocabulary per model.

## Caveats

- The constraint applies from the first generated token. For reasoning
  ("thinking") models, disable thinking for constrained requests (e.g.
  `"chat_template_kwargs": {"enable_thinking": false}`), otherwise the
  `<think>` preamble itself is forced into the constrained shape.
- The first request for a new schema compiles a regex/FSM index (~0.1 s for
  small schemas, more for complex ones). Compiled indexes are cached per
  (model, constraint); the tokenizer vocabulary is processed once per model
  (~0.3 s for a 150k vocabulary).
- Regex features outside the FSM subset (lookarounds, backreferences) and
  unsupported JSON schema constructs are rejected with HTTP 400.

## Maintaining the fork pin

The fork branch is a small patch series on top of an upstream tag. To adopt
a newer mlx-lm: branch from the new tag, cherry-pick the structured-hooks
commit(s), resolve any drift in `mlx_lm/server.py` (the hooks touch request
parsing, `LogitsProcessorArguments`, and `_make_logits_processors`), run this
package's `tests/test_fork_server.py` against it, and update the pin in
`packages/adapter-ai-sdk/src/mlx-env.ts`.

## Development

The package logic is testable without Apple Silicon: the test suite drives
the processor through the numpy kernel backend (`numba` required, declared as
a dev dependency). Fork-dependent tests skip unless the fork is importable.

```sh
uv run pytest python/mlx-lm-structured/tests
```
