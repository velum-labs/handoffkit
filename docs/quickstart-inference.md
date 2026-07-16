# Quickstart: inference endpoint

Canonical user docs live at https://fusionkit.velum-labs.com/docs/getting-started/inference-endpoint; this file is the in-repo mirror.


Run an ensemble as a plain **OpenAI-compatible HTTP endpoint** that any client
(curl, the OpenAI SDK, your app) can point at with no coding harness involved. Every
request fans out across the panel and is synthesized into one answer.

See also: [coding harness](quickstart-harness.md) ·
[rate-limit handoff](quickstart-handoff.md) · [model catalog](model-catalog.md) ·
[CLI reference](cli.md) · [configuration](configuration.md).

## 1. Install + provision (one time)

```bash
pnpm add -g @fusionkit/cli      # or: npm i -g @fusionkit/cli
fusionkit setup                 # pre-provision the Python engine (warm the uv cache)
fusionkit init                  # scaffold Fusion v4 + RouteKit config
export PROVIDER_API_KEY=...     # whichever apiKeyEnv your router references
```

`fusionkit setup` pulls and caches the pinned `fusionkit` synthesizer engine via
`uvx` so the first real request is instant. Prerequisites: `uv` (ships `uvx`) and
`git`. Run `fusionkit doctor` to verify them.

Provider variables are referenced by `.routekit/router.yaml`; FusionKit v4
reads only opaque endpoint IDs. This repository's router needs
`OPENROUTER_API_KEY`.

## 2. Start the endpoint

```bash
cd your-git-repo                # the panel fuses over this repo's code
fusionkit serve --port 8787     # bring up the fused OpenAI-compatible gateway
# omit --port for an ephemeral port; the gateway prints its base URL on start.
export FUSION_URL=http://127.0.0.1:8787
```

`fusionkit serve` composes the configured RouteKit router, Python synthesis
sidecar, and Fusion gateway, then prints front-door setup snippets and stays up
until `Ctrl+C`.

The gateway exposes the usual surface under `/v1`:
`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`,
`/v1/embeddings`, and `/health`, plus a Cursor surface at
`/v1/cursor/chat/completions` and `/v1/cursor/models`. The default fused model
id is **`fusion-panel`**; named ensembles are `fusion-<name>`.

## 3. Call it with streaming

```bash
curl -N "$FUSION_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{
    "model": "fusion-panel",
    "stream": true,
    "messages": [{ "role": "user", "content": "Explain a B-tree in two sentences." }]
  }'
```

`-N` disables curl buffering so you see the Server-Sent Events as the synthesized
answer streams. Drop `"stream": true` for a single JSON response.

## 4. Call it with tool calling

Tools flow through the panel and the judge, so the fused answer can emit
function/tool calls in the OpenAI Chat shape:

```bash
curl "$FUSION_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{
    "model": "fusion-panel",
    "messages": [{ "role": "user", "content": "What is the weather in Paris?" }],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }]
  }'
```

The response contains a `tool_calls` array when the ensemble decides to call a
tool; execute it on your side and post the result back as a `tool` message to
continue the turn, exactly as you would against the OpenAI API.

## Notes

- **Auth.** Add `--auth-token <token>` to require `Authorization: Bearer <token>`
  (or `x-api-key: <token>`) on every request. It is required when `--host` binds
  beyond loopback.
- **Routing.** Provider-facing configuration is `.routekit/router.yaml`; see
  [configuration](configuration.md).
- **Cross-platform.** The cloud endpoint works on Linux, Windows, and macOS.
