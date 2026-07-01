# Quickstart: inference endpoint

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
export OPENAI_API_KEY=...  ANTHROPIC_API_KEY=...  GEMINI_API_KEY=...
```

`fusionkit setup` pulls and caches the pinned `fusionkit` synthesizer engine via
`uvx` so the first real request is instant. Prerequisites: `uv` (ships `uvx`) and
`git`. Run `fusionkit doctor` to verify them.

## 2. Start the endpoint

```bash
cd your-git-repo                # the panel fuses over this repo's code
fusionkit serve --port 8787     # bring up the fused OpenAI-compatible gateway
# omit --port for an ephemeral port; the gateway prints its base URL on start.
export FUSION_URL=http://127.0.0.1:8787
```

`fusionkit serve` spawns the model panel, the `fusionkit serve` router (which
fronts each model and performs synthesis), and the gateway, then prints
front-door setup snippets and stays up until `Ctrl+C`. Add `--local` for an
Apple-Silicon MLX panel, or `--model ID=PROVIDER:MODEL` to pick the panel
(see the [model catalog](model-catalog.md)).

The gateway exposes the usual surface under `/v1`:
`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`,
`/v1/embeddings`, and `/health`. The fused model id is **`fusion-panel`**; each
panel member is also addressable as a direct (non-fused) passthrough by its id.

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
  (or `x-api-key: <token>`) on every request. This is recommended if you bind beyond
  loopback.
- **Raw router (advanced).** `fusionkit config export-yaml` prints the derived
  `fusionkit serve` router config if you want to run the Python router directly;
  see [configuration](configuration.md).
- **Cross-platform.** The cloud endpoint works on Linux, Windows, and macOS.
  `--local` (MLX) is Apple-Silicon-only; `fusionkit doctor` reports this.
