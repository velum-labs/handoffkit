# fusionkit-testkit

A scriptable HTTP provider simulator for tests that need a controllable
RouteKit upstream. It is never published to PyPI.

## What it is

`RouteKitSimulator` is a real HTTP server (stdlib-only, no framework). One
shared behavior queue and journal drive four native provider surfaces:

- **Chat Completions** — `POST /v1/chat/completions` (JSON and SSE
  streaming with realistic chunking: role frame, token deltas, indexed
  tool-call fragments, finish frame, `stream_options.include_usage` usage
  frame).
- **Anthropic Messages** — `POST /v1/messages`.
- **Google GenAI** — `POST /v1beta/models/{model}:generateContent` and
  `:streamGenerateContent`.
- **OpenAI Responses** — `POST /v1/responses`.

Each dialect renders text, reasoning, tool calls, errors, streaming, and usage
in its native wire shape. The journal labels are `openai-chat`,
`anthropic-messages`, `google-generate`, and `openai-responses`.

Point `FusionConfig.routekit_url` at `simulator.url`; the sidecar sends opaque
endpoint ids in the request model field.

## Scripting (the control plane)

Behaviors are queued per model name and consumed FIFO; an unqueued call gets a
deterministic echo default. A behavior can be a reply, tool calls, reasoning,
an HTTP error, injected latency, or a deliberately broken stream.

- **In-process (Python):** `sim.queue("model", Behavior(reply="..."))`.
- **Over HTTP (any language):** `POST /__sim/behaviors`,
  `POST /__sim/reset`, `GET /__sim/journal` — this is how the Node test suite
  scripts it.

## Observability (the journal)

Every request is recorded: API dialect, model, full body, stream flag, and how
it was answered (queued behavior vs default, status, kind). Tests assert on the
journal — *what actually hit the provider wire* — instead of trusting mocks.

## Standalone process

```
uv run --package fusionkit-testkit fusionkit-sim --port 0
```

prints `{"event": "listening", "host": ..., "port": ..., "url": ...}` on
stdout and serves until terminated. Used by the Node `stack-e2e` suite.

See `docs/testing.md` at the repo root for where this fits in the overall
testing strategy.
