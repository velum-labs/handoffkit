# `@velum-labs/routekit-control`

Typed, renderer-free control protocol for the singleton RouteKit daemon.

The package defines explicit `routekit.control.v1` method/parameter/result
types, validates requests at the protocol edge, deduplicates idempotent
mutations, and wraps `@velum-labs/routekit-runtime`'s authenticated `ControlClient`.
Commander argv, terminal rendering, and product state implementations do not
belong here.
