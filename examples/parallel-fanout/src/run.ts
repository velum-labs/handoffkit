import { agents, handoff, localFirst, reviewStrategies, targets } from "@fusionkit/handoff";
import { withStackAndRepo } from "@fusionkit/testkit";

import { demoBanner, detail, finale, ok, step } from "@fusionkit/example-utils";

async function main(): Promise<void> {
  demoBanner("07");

  await withStackAndRepo({ pool: "eng-prod", files: { "README.md": "# migration target\n", "legacy.ts": "export var x = 1;\n" } }, async ({ stack, repo }) => {
    const h = handoff({
      workspace: repo,
      plane: { url: stack.planeUrl, adminToken: stack.adminToken },
      actor: { kind: "human", id: "dana@example.com" },
      agent: agents.mock(),
      policy: localFirst({ allowPools: ["eng-prod"], maxParallelRuns: 3 })
    });

    step("fan one checkpoint out into three isolated strategies");
    const runs = await h.parallel(
      [
        "smallest safe fix",
        "compatibility-preserving refactor",
        "rewrite with better test coverage and a much longer explanation of why"
      ],
      targets.pool("eng-prod"),
      { reason: "explore three migration strategies" }
    );
    const checkpointId = runs[0]?.envelope.checkpoint.checkpointId ?? "?";
    ok(`three governed runs share checkpoint ${checkpointId}`);

    step("runners execute each attempt in its own session");
    for (let i = 0; i < runs.length; i++) await stack.runOnce();
    for (const run of runs) await run.wait();

    step("review the attempts with a typed, deterministic strategy");
    const review = await h.review(runs, { choose: reviewStrategies.smallestDiff() });
    for (const candidate of review.candidates) {
      const marker = candidate.run.runId === review.chosen.run.runId ? "→" : " ";
      detail(
        `${marker} ${candidate.run.runId}  diff ${String(candidate.diffBytes).padStart(5)} bytes  "${candidate.run.envelope.task.prompt.slice(0, 48)}"`
      );
    }
    ok(`chosen: ${review.chosen.run.runId} — ${review.reason}`);

    step("pull the winner; isolation keeps it off your working tree if you diverged");
    const pulled = await review.chosen.run.pull();
    switch (pulled.mode) {
      case "applied":
        ok("applied directly: the local workspace was still at the checkpoint base");
        break;
      case "branch":
        ok(`local work diverged; the winner landed on branch ${pulled.branch}`);
        break;
      case "empty":
        ok("the winning attempt produced no workspace changes");
        break;
      default: {
        const exhausted: never = pulled;
        throw new Error(`unreachable: ${String(exhausted)}`);
      }
    }

    step("every attempt keeps its own receipt — including the losers");
    for (const run of runs) {
      const bundle = await run.receipt();
      detail(`${run.runId}: ${bundle.receipt.status}, ${bundle.receipt.eventCount} events, contract ${bundle.receipt.contractHash.slice(0, 12)}`);
    }
    finale("fan-out is one continuation pattern inside the same governed plane");
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
