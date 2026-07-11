import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderReceipt, renderTrace } from "@fusionkit/example-utils";
import { agents, handoff, localFirst, targets } from "@fusionkit/handoff";
import { git, withStackAndRepo } from "@fusionkit/testkit";

import { demoBanner, detail, finale, ok, step } from "@fusionkit/example-utils";

async function main(): Promise<void> {
  demoBanner("06");

  await withStackAndRepo({ pool: "eng-prod", files: {
      "README.md": "# search-service\n",
      "src/ranker.ts": "export const rank = (xs: number[]) => xs.sort();\n"
    } }, async ({ stack, repo }) => {
    step("work starts locally: half-finished edits, laptop about to go offline");
    writeFileSync(
      join(repo, "src/ranker.ts"),
      "export const rank = (xs: number[]) => xs.toSorted(); // WIP: needs tests\n"
    );

    step("create a continuation context bound to the workspace and the plane");
    const h = handoff({
      workspace: repo,
      plane: { url: stack.planeUrl, adminToken: stack.adminToken },
      actor: { kind: "human", id: "dana@example.com" },
      agent: agents.mock(),
      policy: localFirst({ allowPools: ["eng-prod"] })
    });
    detail('h = handoff({ workspace, plane, agent: agents.mock(), policy: localFirst({ allowPools: ["eng-prod"] }) })');

    step("first, ask what would move — dry run, nothing uploaded");
    const { report } = await h.dryRun(targets.pool("eng-prod"), {
      task: "finish the ranker refactor and run the tests",
      reason: "laptop going offline; tests are slow locally"
    });
    detail(
      `would move: workspace @ ${report.workspace.baseRef.slice(0, 12)}` +
        (report.workspace.dirtyDiffHash ? " + uncommitted diff" : "") +
        ` → pool "${report.pool}" (decision: ${report.policyDecision.decision})`
    );

    step('one gesture: await h.continueIn(targets.pool("eng-prod"), { task, reason, transcript })');
    const run = await h.continueIn(targets.pool("eng-prod"), {
      task: "finish the ranker refactor and run the tests",
      reason: "laptop going offline; tests are slow locally",
      transcript:
        "user: the ranker sort mutates input, fix it\nagent: switched to toSorted(), tests still pending"
    });
    ok(`envelope ${run.envelope.envelopeId} (${run.envelopeHash.slice(0, 12)}) became governed run ${run.runId}`);
    ok("the signed contract pins the envelope hash — continuation provenance is part of the receipt");

    step("a runner in eng-prod picks it up; the laptop can close now");
    await stack.runOnce();
    const outcome = await run.wait();
    ok(`remote work finished [${outcome.status}]`);

    step("the local trace explains every boundary decision");
    detail(renderTrace(h.trace()));

    step("pull the results back, divergence-safe");
    git(repo, ["checkout", "--", "."]);
    const pulled = await run.pull();
    ok(`pull mode: ${pulled.mode}`);
    const output = readFileSync(join(repo, "MOCK_AGENT.md"), "utf8");
    detail(`agent output landed locally: MOCK_AGENT.md (${output.length} bytes)`);

    step("and the receipt still answers the five questions");
    detail(renderReceipt(await run.receipt()));

    finale("continuation is a demo of the primitives: contract + envelope + receipt");
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
