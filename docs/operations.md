# Operations

This page summarizes how the implemented control plane and runner are meant to
be operated locally or in a small deployment.

## Deployment shapes

- **Local development** runs `warrant plane start` and `warrant runner start` in
  separate terminals with local config and encrypted secret state.
- **Docker compose** starts the plane, a runner, and seeded showcase data for the
  control panel.
- **Outbound runner pools** keep runners behind firewalls or on controlled hosts;
  runners poll the plane and claim compatible contracts.

## Plane responsibilities

The plane owns online authority:

- Principal authentication, roles, rotation, revocation, and optional IdP-backed
  approval assertions.
- Contract issuance, atomic claims, lifecycle transitions, cancellation, and
  approval waits.
- Policy evaluation for agent kind, runner pool, capabilities, egress, secrets,
  approvals, and retention.
- Secret storage and release brokering with encrypted at-rest state.
- Receipt countersignature, audit export, metrics, structured logs, and the
  dependency-free control panel at `/ui/`.

Primary source files are `packages/plane/src/plane.ts`,
`packages/plane/src/server.ts`, `packages/plane/src/sqlite-store.ts`,
`packages/plane/src/policy.ts`, and `packages/plane/src/secrets.ts`.

## Runner responsibilities

Runners own execution, not authorization:

- Poll the plane outbound and claim only compatible contracts.
- Materialize the signed workspace manifest.
- Run the requested harness in the configured session backend.
- Enforce or delegate egress restrictions according to backend capability.
- Record event evidence, collect outputs, sign runner receipts, and return them
  to the plane for countersignature.

Primary source files are `packages/runner/src/runner.ts`,
`packages/runner/src/backend.ts`, and the `packages/session-*` backends.

## Storage and retention

The current durable store is SQLite through `packages/plane/src/sqlite-store.ts`.
The `PlaneStore` interface is the seam for replacing SQLite with a multi-node
store such as Postgres. Retention and garbage collection live in
`packages/plane/src/retention.ts`.

## Security posture

- Protocol verification uses Node built-ins and dependency-light primitives to
  keep offline verification auditable.
- Requests are validated at the plane boundary before contract issuance.
- Run claims are atomic to prevent duplicate execution.
- Replay protection, rate limiting, principal revocation, master-key encrypted
  secret state, and structured audit trails are implemented in the plane.
- Isolation strength is backend-specific and recorded in receipts; true TEE
  attestation remains out of scope unless explicitly implemented by a backend.

## Maintenance commands

```sh
pnpm check
pnpm build
pnpm test
pnpm verify
```

Release-package workflow details live in [Release publishing](release-publishing.md).
