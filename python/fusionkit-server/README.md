# fusionkit-server

Internal synthesis sidecar for FusionKit.

This package exposes only the internal health, trajectory-fusion, native-run,
and tool-resume APIs used by the Node `@fusionkit/cli` process. It does not
provide a public model gateway or direct model passthrough.

The sidecar is started automatically. Maintainers can run it from a checkout
with `uv run --package fusionkit fusionkit-sidecar serve -c <config.yaml>`.
Public OpenAI, Anthropic, Cursor, and model-discovery surfaces are owned by the
Node RouteKit gateway.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
