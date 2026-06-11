# HandoffKit

The coordination layer for hybrid distributed AI compute.

HandoffKit is a local-first SDK and platform for moving AI work across execution boundaries without forcing developers to redesign their agent, workspace, or model stack.

The core primitive is a handoff contract: a signed, resumable description of run state, workspace state, capability needs, privacy policy, and resume semantics.

## Status

Design-stage repository. Implementation is intentionally blocked until the SDK shape, adapter boundaries, and demo flows are agreed.

## Thesis

AI work no longer lives in one process, model, machine, or trust boundary. A run may start in an IDE, use a local model, call local tools, continue in a cloud sandbox, request a stronger model, move to private compute when secrets appear, wait for human approval, and return results to a PR or local workspace.

HandoffKit owns the continuity layer across that graph:

- run record
- state envelope
- continuation decision
- policy and secret boundary
- artifact trail
- audit log
- resume contract

## Product invariant

Every meaningful transition must answer:

1. What moved?
2. Why did it move?
3. Who or what approved it?
4. Which runtime, model, tools, data, and secrets saw it?
5. How can the user resume, inspect, revoke, or reproduce it?

If the platform cannot answer those questions, it is just remote execution with branding.

## Current artifact

- [Local-first handoff platform SDK spec](spec/2026-06-11-local-first-handoff-platform-spec.md)
