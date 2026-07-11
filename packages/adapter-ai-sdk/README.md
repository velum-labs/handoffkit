# @fusionkit/adapter-ai-sdk

AI SDK and local-model helpers for FusionKit.

## Architecture

This package contains product-local AI SDK adapters and managed MLX local-model server helpers used by `fusionkit models` and `--local` flows; governed remote tools and handoff-aware model routing live in legacy `@fusionkit/handoff`.

## Usage

Install `@fusionkit/cli` for the product workflow; import this package for custom AI SDK integrations.

```ts
import * as fusionkitPackage from "@fusionkit/adapter-ai-sdk";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
