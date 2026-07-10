# fusionkit-testkit

A realistic, scriptable **LLM provider simulator** for testing FusionKit end to
end without provider keys or billing. Never published to PyPI; it exists so the
test suites (Python and Node) can drive the *real* product stack — real
provider SDK clients, real wire parsing, real retry/error classification, the
real `fusionkit serve` process — against a provider that the test fully
controls and can observe.

## What it is

`ProviderSimulator` is a real HTTP server (stdlib-only, no framework) that
speaks the two provider wire dialects FusionKit's Python clients use:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` (JSON and SSE
  streaming with realistic chunking: role frame, token deltas, indexed
  tool-call fragments, finish frame, `stream_options.include_usage` usage
  frame), `GET /v1/models`.
- **Anthropic Messages** — `POST /v1/messages` (JSON and SSE:
  `message_start` → `content_block_*` → `message_delta` → `message_stop`,
  including `input_json_delta` tool-argument fragments).

Point a `ModelEndpoint.base_url` (or the openai / anthropic SDK `base_url`) at
`simulator.url` and the real client code runs unmodified.

## Scripting (the control plane)

Behaviors are queued per model name and consumed FIFO; an unqueued call gets a
deterministic echo default. A behavior can be a reply, tool calls, reasoning,
a provider-shaped error (429 / 401 / quota / context overflow / 529 / 500,
with `retry-after`), injected latency, or a deliberately broken stream.

- **In-process (Python):** `sim.queue("model", Behavior(reply="..."))`.
- **Over HTTP (any language):** `POST /__sim/behaviors`,
  `POST /__sim/reset`, `GET /__sim/journal` — this is how the Node test suite
  scripts it.

## Observability (the journal)

Every request is recorded: API dialect, model, full body, auth header
presence, stream flag, and how it was answered (queued behavior vs default,
status, kind). Tests assert on the journal — *what actually hit the provider
wire* — instead of trusting that mocks were called.

## Standalone process

```
uv run --package fusionkit-testkit fusionkit-sim --port 0
```

prints `{"event": "listening", "host": ..., "port": ..., "url": ...}` on
stdout and serves until terminated. Used by the Node `stack-e2e` suite.

See `docs/testing.md` at the repo root for where this fits in the overall
testing strategy.
