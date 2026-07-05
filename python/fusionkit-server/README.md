# fusionkit-server

OpenAI-compatible HTTP server for FusionKit.

This package contains the FastAPI app behind `fusionkit serve`, including chat-completions routing, panel fanout, synthesis, and health endpoints. The npm `@fusionkit/cli` starts this engine for normal harness workflows.

Most users should run `fusionkit serve` through the installed CLI or `uvx fusionkit`; depend on this package when embedding the raw ASGI app.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
