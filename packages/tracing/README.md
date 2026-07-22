# @fusionkit/tracing

OpenTelemetry-based tracing for the fusion stack.

## Architecture

`@routekit/tracing` owns the generic OTel provider, W3C propagation, listeners, and policy-based export redaction. This package is the one-way FusionKit conventions facade: typed span/event helpers, Fusion baggage and attributes, and the generated semantic conventions in `spec/fusion-trace/registry.json`.

## Usage

Most users get tracing automatically through `@fusionkit/cli` (`--observe`, `OTEL_EXPORTER_OTLP_ENDPOINT`); library users can import the helpers directly.

```ts
import * as fusionkitPackage from "@fusionkit/tracing";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
