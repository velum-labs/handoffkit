# Handoff SDK

`@warrant/handoff` is the continuation-first developer surface. It packages
local state into Warrant checkpoints, requests governed runs through the plane,
and pulls results back with receipts.

## Golden shape

```ts
import { agents, handoff, targets } from "@warrant/handoff";

const h = await handoff({
  task: "fix the flaky auth test",
  agent: agents.claudeCode(),
  target: targets.pool("eng-prod")
});

await h.checkpoint({ note: "local investigation complete" });

if (h.needs(targets.pool("eng-prod"))) {
  const run = await h.continueIn(targets.pool("eng-prod"), {
    task: "apply the plan and run tests"
  });

  await h.pull(run.runId);
}

console.log(await h.summary());
```

## What the SDK records

- Workspace checkpoints and content-addressed manifests.
- Tool journals for AI SDK-shaped local tools wrapped by `h.tools(...)`.
- Run requests, terminal statuses, review decisions, pull results, and receipt
  verification commands.
- Model routing decisions when using handoff-aware model helpers.

## Important APIs

| API | Purpose | Source |
| --- | --- | --- |
| `handoff(...)` | Create a continuation context with task, agent, target, workspace, and policy intent. | `packages/handoff/src/handoff.ts` |
| `h.checkpoint(...)` | Capture workspace and semantic state before a boundary crossing. | `packages/handoff/src/checkpoint-manager.ts` |
| `h.continueIn(...)` | Submit a governed run to another target pool. | `packages/handoff/src/run.ts` |
| `h.parallel(...)` | Fork a checkpoint into isolated attempts. | `packages/handoff/src/run.ts` |
| `h.review(...)` | Select or summarize attempts using deterministic evidence. | `packages/handoff/src/review.ts` |
| `h.pull(...)` | Bring remote results back with divergence protection. | `packages/handoff/src/run-executor.ts` |
| `h.tools(...)` | Wrap local AI SDK-shaped tools and journal semantic state. | `packages/handoff/src/tools.ts` |

## Design rules

- Handoff is a composition layer, not a second trust model; every remote step is
  still a signed contract and receipt.
- Boundary changes should be explicit and fail closed through `h.needs(...)`,
  policy, target descriptors, and approvals.
- Local model loops remain app-owned; Warrant governs tool and continuation
  boundaries and labels that scope honestly in receipts and traces.
