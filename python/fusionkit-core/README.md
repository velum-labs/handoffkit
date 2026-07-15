# fusionkit-core

Core Python primitives for FusionKit model fusion.

This package owns fusion policy, prompts, judge/synthesis behavior, run records,
and one neutral OpenAI-compatible RouteKit client. RouteKit owns provider
accounts, credentials, retries, balancing, and pricing.

Most users should install `@fusionkit/cli`; import `fusionkit-core` directly
only when developing the internal synthesis sidecar.

Docs: https://fusionkit.velum-labs.com
Repository: https://github.com/velum-labs/handoffkit
