# fusionkit-server

OpenAI-compatible HTTP server for FusionKit.

This package contains the FastAPI app behind `fusionkit serve`, including chat-completions routing, panel fanout, synthesis, and health endpoints. The npm `@fusionkit/cli` starts this engine for normal harness workflows.

Most users should run `fusionkit serve` through the installed CLI or `uvx fusionkit`; depend on this package when embedding the raw ASGI app.

## Using FusionKit from Cursor

Cursor's "Override OpenAI Base URL" (BYOK) feature can point directly at a running `fusionkit serve` instance via the dedicated `/v1/cursor` route, which accepts Cursor's non-standard request format (a Responses-API-shaped body POSTed to `/chat/completions`, Cursor's known BYOK hybrid) and translates it into standard Chat Completions handling. This mirrors OpenRouter's `/api/v1/cursor` endpoint.

Setup:

1. Start the server, e.g. `fusionkit serve -c <config.yaml> --host 127.0.0.1 --port 8080`.
2. In Cursor: **Settings → Models → API Keys**, enable **OpenAI API Key** and set **Override OpenAI Base URL** to `http://127.0.0.1:8080/v1/cursor`. Cursor may require a value in the key field even though the local server ignores it — any placeholder works.
3. Add custom model ids matching your served endpoint ids (the `id` of each configured endpoint) or `fusionkit/panel` for the fused ensemble, and select one in chat.

Cursor appends `/chat/completions` to the base URL, so requests land on `/v1/cursor/chat/completions`; the route also accepts plain Chat Completions bodies (Ask mode) unchanged, and `/v1/cursor/models` mirrors `/v1/models` for model probing.

Caveats:

- Tab-completion never uses BYOK models; only chat/agent modes do.
- Auto/Composer model selection may bypass BYOK — pick an explicit model.
- If Cursor cannot connect to a local server, switch Cursor's HTTP Compatibility Mode to HTTP/1.1.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
