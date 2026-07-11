> **Frozen.** This tree is the legacy Warrant governance stack. It is not
> built, not tested, not published from this repo, and not part of the
> FusionKit product. The npm packages published from it
> (`@fusionkit/sdk`, `@fusionkit/plane`, `@fusionkit/runner`,
> `@fusionkit/handoff`, `@fusionkit/adapter-compute`,
> `@fusionkit/session-vercel-sandbox`, `@fusionkit/session-hermetic`,
> `@fusionkit/session-harness`) are deprecated.

# Legacy quarantine

This folder quarantines the legacy "Warrant" governed-execution stack.

It is not part of the FusionKit model-fusion product; see
[`docs/scope.md`](../docs/scope.md) for the current product boundary.

## Contents

- `packages/`: legacy publishable packages (`plane`, `runner`, `sdk`,
  `handoff`, `adapter-compute`, `session-hermetic`,
  `session-vercel-sandbox`, `session-harness`).
- `examples/`: legacy governed-execution demos, including governed runs,
  handoff, remote tools, swarm, model escalation, control panel seeding, and
  microVM isolation measurements.
- `docker/`: the legacy Warrant compose stack and a Docker-only `warrant`
  entrypoint used by the legacy smoke test.
- `specs/`: governance, handoff, microVM, and secret-disclosure design specs.
- `docs/`: historical internal documentation preserved outside the product docs.

The package names and publish identities are unchanged. The quarantine is a
filesystem split inside this monorepo; unpublishing or extracting the legacy
stack is deferred pending owner decisions.
