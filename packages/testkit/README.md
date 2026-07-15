# @fusionkit/testkit

Private cross-stack test tooling for FusionKit (never published). Not to be confused with the legacy `legacy/packages/testkit`, which serves the retained Warrant platform.

## Architecture

Composable layers for realistic end-to-end tests: `startProviderSim` spawns a
scriptable RouteKit-compatible upstream (`python/fusionkit-testkit`) as a child
process, driven over its HTTP control plane and observed through its wire
journal; `simSidecarConfigYaml` builds production-shaped sidecar config from
opaque endpoint IDs; and `startEngine` runs the internal `fusionkit-sidecar`
process — the same entrypoint the production CLI spawns. SSE parsing helpers and
honest skip-gating for environments without the Python toolchain round out the
surface.

## Docs

- Testing strategy and layer map: [../../docs/testing.md](../../docs/testing.md)
