# @routekit/runtime

`packages/runtime-utils` publishes `@routekit/runtime`: brand-neutral runtime
utilities shared by RouteKit and product packages.

## Architecture

This package contains leaf helpers for process supervision and process-group
termination, timeouts, cleanup, atomic files and locks, held/free ports,
formatting, and runtime defaults. It also owns shared child-environment policy,
URL/bind validation, and optional portless service discovery and registration.
All APIs use the stable `@routekit/runtime` root export even though source is
split across focused modules in this directory.

## Usage

Most users install it through a higher-level package.

```ts
import {
  assertAuthenticatedBind,
  buildChildEnv,
  createPortlessSession,
  superviseSpawn,
  writeFileAtomic
} from "@routekit/runtime";
```

Key API groups:

- process lifecycle: `superviseSpawn`, `runCliCapture`, `spawnLogged`,
  `terminateGroup`, `waitForHttp`, and `waitForOutput`
- safe environments and URLs: `buildChildEnv`, `scrubBridgeEnv`,
  `normalizeApiBaseUrl`, and `assertAuthenticatedBind`
- services and files: `createPortlessSession`, `reservePort`,
  `writeFileAtomic`, and `tryAcquireFileLock`
- shared utility policy: `defineTimeouts`, `withDeadline`, `withTimeout`, and
  runtime default constants

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
