# @fusionkit/model-gateway

FusionKit harness gateway and durable session store.

## Architecture

This package translates OpenAI Responses, OpenAI Chat, Anthropic Messages, and ACP-style harness traffic into FusionKit panel or passthrough model calls.

## Usage

Most users should run it through `@fusionkit/cli`; library users can import `startGateway` for embedded tests or custom launchers.

```ts
import * as fusionkitPackage from "@fusionkit/model-gateway";
```

The subscription pooling proxy (account enrollment, selection strategies, and the provider-native proxy server) ships on the `./subscriptions` export subpath:

```ts
import { startSubscriptionProxy } from "@fusionkit/model-gateway/subscriptions";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
