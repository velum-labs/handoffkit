# Warrant (working name)

The governed execution and provenance plane for AI agents.

Run any vendor's agent — Claude Code, Codex, Cursor CLI — on a runtime you control, under policy, with a signed receipt proving what it saw, ran, changed, and was given.

The two core objects are the **run contract** (a signed authorization to execute under stated conditions) and the **receipt** (a signed, offline-verifiable record of what actually happened).

## Status

MVP kernel implemented (`src/`): protocol (signed contracts, hash-chained events, offline-verifiable receipts), control plane, outbound-only runner, agent adapters (Claude Code, Codex, and a built-in mock for tests), workspace capture with divergence-safe pull, secret broker, and the `warrant` CLI. Zero runtime dependencies — the kernel runs on Node built-ins only.

The validation gate in the spec (design-partner interviews) still governs go-to-market.

## Quickstart

```sh
pnpm install && pnpm build

# one-time: org keys, config, policy
node dist/cli/index.js init

# terminal 1: control plane
node dist/cli/index.js plane start

# terminal 2: an outbound-only runner (your machine is the "customer infra")
node dist/cli/index.js runner start --pool default

# terminal 3: a governed run in any git repo
cd your-repo
node ../path/to/dist/cli/index.js run --agent mock "try the kernel"      # no API keys needed
node ../path/to/dist/cli/index.js run --agent claude-code "fix the bug"  # wraps the real CLI

# what would move, without moving anything
node dist/cli/index.js run --agent mock --dry-run "probe"

# the product: one screen, five questions — then prove it offline
node dist/cli/index.js receipt run_...
node dist/cli/index.js bundle run_... --out bundle.json
node dist/cli/index.js verify bundle.json
```

## Thesis

AI work crosses trust boundaries — laptops, vendor clouds, customer VPCs, attested runtimes — and that shift is permanent. Vendors already own continuation *inside* their silos and give it away. What no vendor can ship is the cross-vendor answer to what their agents did: Anthropic will not audit Codex, and Cursor will not govern Claude Code.

The unowned layer is governed execution and provenance:

- execution of vendor harnesses, wrapped as-is, on customer-controlled runners
- policy decided before execution and enforced at the session boundary
- signed, hash-chained receipts portable across vendors and runtimes
- secret release that is brokered, scoped, and logged — never prompted
- offline verification that requires trusting no one, including us

## Product invariant

Every run must answer:

1. What moved?
2. Why did it move?
3. Who or what approved it?
4. Which runtime, model, tools, data, and secrets saw it?
5. How can the user resume, inspect, revoke, or reproduce it?

If the platform cannot answer those questions from a signed receipt, on one screen, without trusting the runtime that executed the work, it is just remote execution with branding.

## Current artifact

- [Governed agent execution plane spec](spec/2026-06-11-governed-agent-execution-plane-spec.md)

## Superseded

- [Local-first handoff platform SDK spec](spec/2026-06-11-local-first-handoff-platform-spec.md) — the predecessor "HandoffKit" artifact, retained for record. Its positioning ("The coordination layer for hybrid distributed AI compute.") is superseded: continuation and handoff are now demos of the primitives, not the product.
