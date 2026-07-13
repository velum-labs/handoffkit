# @fusionkit/tracing

OpenTelemetry-based tracing for the fusion stack.

## Architecture

The engine is the OTel SDK (ids, W3C propagation, batching, flush, OTLP export); this package owns the thin domain layer: typed span and event helpers over the fusion semantic conventions (`spec/fusion-trace/registry.json`), the serializable trace carrier that threads context through values, HTTP headers, and child environments, and the in-process span/event listeners the narrator and product telemetry subscribe to. Published to npm alongside the other `@fusionkit/*` packages.

## Usage

Most users get tracing automatically through `@fusionkit/cli` (`--observe`, `OTEL_EXPORTER_OTLP_ENDPOINT`); library users can import the helpers directly.

```ts
import * as fusionkitPackage from "@fusionkit/tracing";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
