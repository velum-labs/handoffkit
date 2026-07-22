# `@routekit/daemon`

Composition root for RouteKit's singleton daemon.

One process owns the authenticated private control listener and a stable
OpenAI-compatible data listener. Router generations run behind the stable
front door: config/account changes build a complete candidate, atomically
switch new requests, then drain the old generation. The daemon is the sole
writer for canonical config, account enrollment, revisions, catalog/health
snapshots, and telemetry state.

Applications normally use it through `@routekit/cli`; embedders should keep
using `@routekit/router` instead of claiming the singleton service record.
