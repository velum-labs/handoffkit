# Warrant (working name)

The governed execution and provenance plane for AI agents.

Run any vendor's agent — Claude Code, Codex, Cursor CLI — on a runtime you control, under policy, with a signed receipt proving what it saw, ran, changed, and was given.

The two core objects are the **run contract** (a signed authorization to execute under stated conditions) and the **receipt** (a signed, offline-verifiable record of what actually happened).

## Status

Design-stage repository. Implementation is intentionally blocked until the run contract, runner contract, and trust architecture are agreed — and until the validation gate in the spec (design-partner interviews) passes.

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
