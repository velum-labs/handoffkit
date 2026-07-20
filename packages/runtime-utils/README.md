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
- service lifecycle (`src/service/`): product-agnostic building blocks for
  running a CLI's serve command as a managed service — `createServiceRecordStore`
  (versioned pid/URL records with liveness reaping and pid-guarded removal),
  `startDaemon`/`stopDaemonProcess`/`waitForServiceReady` (lock-protected
  detached daemonization with rotated logs and health-verified readiness),
  `detectSupervisor`/`supervisorController` with pure `systemdServiceUnit` and
  `launchdAgentPlist` generators (OS persistence via systemd user units or
  launchd agents), and `planUpgrade`/`upgradeDetachedDaemon` (version-skew
  detection, blue-green or drain-restart replacement)
- daemon control transport: `startControlServer` / `ControlClient` provide a
  loopback-only, random-bearer-authenticated `control.v1` JSON/NDJSON channel
  with bounded bodies, structured errors, cancellation, deadlines, and event
  streams; `acquireLifecycleLock` records pid + nonce, serializes all lifecycle
  mutations, reaps dead owners, and protects release from deleting a
  successor's lock

## Service lifecycle for product CLIs

Any product with a long-running serve command (RouteKit today; FusionKit and
future products can adopt the same core) binds it by constructing a
`ServiceDaemonSpec` — product name, state home, CLI version, and the
foreground serve invocation — and reusing the shared machinery for start,
stop-with-drain, OS supervision, and graceful upgrade. The serve process
itself writes the service record (stamped with `version`, `binPath`, launch
`args`, `cwd`, and its `supervisor` from `SERVICE_SUPERVISOR_ENV`), which is
the on-disk contract every management command reads.

Combined product daemons extend that record with a monotonic authority
`generation`, negotiated `protocolVersion`, private `controlToken`, and stable
`dataUrl` / `dataPort`. A client must verify authenticated control health, not
merely PID liveness, before trusting the record. Product-specific method
schemas stay outside this neutral package (`@routekit/control` for RouteKit);
raw argv is never an RPC protocol.

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
