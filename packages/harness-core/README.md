# @routekit/harness-core

`packages/harness-core` publishes `@routekit/harness-core`: the product-neutral
coding-agent harness contract. Its test helpers are published from
`@routekit/harness-core/testing`.

## Architecture

This package defines the shared driver → instance → session interfaces,
canonical event union, tagged errors and retryability, approval policy, status
cache, stream-JSON parsing, process primitives, temporary-directory sweeping,
and explicit driver registry used by tool adapters.

## Usage

Use it when implementing or testing a new coding-agent harness adapter.

```ts
import {
  createCachedHarnessDriver,
  probeCliVersion
} from "@routekit/harness-core";
import { driverContractSuite } from "@routekit/harness-core/testing";
import type { HarnessDriver } from "@routekit/harness-core";
```

`createCachedHarnessDriver()` supplies the common probe/cache/create lifecycle
for an adapter. `probeCliVersion()` normalizes CLI availability/version checks,
and `resolveDriverEnv()` preserves an explicitly supplied driver environment.
Adapter packages should use `driverContractSuite()` and `createMockDriver()`
from the testing subpath for contract coverage.

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
