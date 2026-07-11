# Concepts

> **Legacy:** Historical legacy documentation. This page describes the archived Warrant governance product, not the FusionKit model-fusion user journey.


Warrant is built around a small set of signed, content-addressed objects and the
services that exchange them.

## Core objects

| Concept | Meaning | Where implemented |
| --- | --- | --- |
| Run contract | A signed authorization to run a specific task under stated policy, identity, workspace, tool, model, secret, egress, and runtime conditions. | `packages/protocol/src/types.ts`, `packages/protocol/src/contract.ts` |
| Receipt | A signed record of what actually happened: status, events, evidence, workspace changes, runtime details, secrets released, and verification material. | `packages/protocol/src/receipt.ts` |
| Event chain | Hash-chained run events used for timeline integrity and replayable audit stories. | `packages/protocol/src/chain.ts` |
| Manifest | Content-addressed description of captured workspace inputs and outputs. | `packages/protocol/src/types.ts`, `packages/workspace/src/index.ts` |
| Policy | Deny-by-default rules over identity, agent kind, runner pool, network egress, secrets, approvals, and capabilities. | `legacy/packages/plane/src/policy.ts` |
| Checkpoint | Portable continuation state: workspace snapshot plus semantic state such as tool journals and model routing decisions. | `packages/protocol/src/checkpoint.ts`, `legacy/packages/handoff/src/checkpoint-manager.ts` |
| Handoff envelope | A portable description of continuation intent and the checkpoint to move across a runtime boundary. | `packages/protocol/src/handoff.ts`, `legacy/packages/handoff/src/handoff.ts` |

## Runtime actors

- **Client** creates run requests through the CLI, SDK, handoff SDK, AI SDK
  adapter, compute adapter, or a demo.
- **Control plane** turns requests into signed contracts, evaluates policy,
  brokers secrets, records events, handles approvals, countersigns receipts, and
  serves the control panel.
- **Runner** polls outbound, claims eligible contracts, materializes workspaces,
  executes the configured agent harness in a session backend, and signs runner
  receipts.
- **Session backend** provides the isolation boundary for the actual execution:
  hermetic just-bash, Vercel Sandbox microVMs, or AI SDK harness bindings.
- **Verifier** checks signatures, hashes, event chains, and receipt bundles
  offline using `@fusionkit/protocol` and `@fusionkit/sdk`.

## The five receipt questions

Receipts are designed to answer, without trusting the online plane:

1. Who asked for the work, and under which authority?
2. What was the agent asked to do?
3. What code, files, tools, model, runtime, network, and secrets could it see?
4. What happened during execution?
5. What changed, and can the result be pulled or audited safely?

## Continuation model

Continuation is not a separate transport. The handoff SDK packages local work as
a checkpoint, asks the plane for a governed run, and later pulls the receipt and
workspace delta back through the same provenance model. Parallel attempts,
reviews, cloud escalation, and local swarm dispatch are all topologies over the
same contract/receipt primitives.
