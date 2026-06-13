/**
 * Demo 14 — cloud orchestrator, local swarm (deterministic CI walkthrough).
 *
 * The orchestration loop in production is a vendor harness's own (Claude Code
 * dynamic workflows, a Codex goal) running through `HarnessAgent`; see
 * cockpit.ts for that live, terminal-UI form. Here a scripted orchestrator
 * drives the exact same governed surface — `swarmTools()` — so the whole loop
 * runs without keys or a TTY: dispatch a fan-out, watch it, judge completed
 * workers from deterministic evidence and pull the clean ones, catch overlaps
 * from receipts, and escalate the rest to a cloud target.
 *
 * Workers here are the built-in mock harness on the process tier (key-free);
 * in the live cockpit they are pi agents on a local model. Either way every
 * dispatch and escalation is a signed governed run with a verifiable receipt,
 * and only governed-run pulls ever mutate the workspace of record.
 */
import { agents } from "@warrant/handoff";
import { swarmTools } from "@warrant/adapter-ai-sdk";
import type {
  DispatchOutput,
  EscalateOutput,
  PullOutput,
  StatusOutput
} from "@warrant/adapter-ai-sdk";
import { withStackAndRepo } from "@warrant/testkit";

import { demoBanner, detail, finale, ok, step } from "@warrant/example-utils";

const POOL = "swarm-pool";
const CTX = { toolCallId: "demo", messages: [] };

async function main(): Promise<void> {
  demoBanner("14");

  await withStackAndRepo(
    {
      pool: POOL,
      startRunner: true,
      // A concurrent runner so the worker fan-out actually runs in parallel.
      concurrency: 4,
      pollIntervalMs: 25,
      files: { "README.md": "# swarm target\n", "TASKS.md": "- docs\n- tests\n" },
      policy: (policy) => {
        policy.agents.allow = ["mock"];
      }
    },
    async ({ stack, repo }) => {
      step("the orchestrator is handed swarmTools(): dispatch / status / pull / escalate");
      const swarm = swarmTools({
        workspace: repo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        workerPool: POOL,
        cloudPool: POOL,
        actor: { kind: "human", id: "orchestrator@example.com" },
        // Key-free CI substitutes: mock workers and a mock cloud agent on the
        // process tier. The live cockpit uses pi workers and claude-code.
        workerAgent: agents.mock(),
        workerSession: "process",
        cloudAgent: agents.mock(),
        cloudSession: "process",
        maxEscalations: 2
      });
      const dispatch = swarm.tools.dispatch_workers.execute;
      const status = swarm.tools.worker_status.execute;
      const pull = swarm.tools.pull_worker.execute;
      const escalate = swarm.tools.escalate_task.execute;
      if (!dispatch || !status || !pull || !escalate) {
        throw new Error("swarm tools must expose execute()");
      }

      step("dispatch_workers: fan the goal out across cheap local workers");
      const dispatched = (await dispatch(
        {
          tasks: [
            { prompt: "update the documentation", fileScope: ["README.md"] },
            { prompt: "add the missing tests", fileScope: ["TASKS.md"] }
          ]
        },
        CTX
      )) as DispatchOutput;
      ok(`dispatched ${dispatched.dispatched.length} governed worker(s) to pool "${POOL}"`);
      const runIds = dispatched.dispatched.map((d) => d.runId);

      step("worker_status: a non-blocking glance while the swarm runs");
      const reported = (await status({ runIds }, CTX)) as StatusOutput;
      detail(reported.statuses.map((s) => `${s.runId} → ${s.status}`).join("\n"));

      step("pull_worker: judge each worker from deterministic evidence, compose the disjoint ones");
      let accepted = 0;
      const toEscalate: string[] = [];
      for (let i = 0; i < runIds.length; i++) {
        const runId = runIds[i] ?? "";
        const result = (await pull({ runId }, CTX)) as PullOutput;
        if (result.verdict === "accepted") {
          accepted++;
          detail(
            `worker ${runId} → verdict: accepted ` +
              `(receipt verified: ${result.receipt?.verified ?? false}; ` +
              `diff ${result.scorecard?.diffBytes ?? 0} bytes; ` +
              `files ${result.filesChanged.join(", ")})`
          );
        } else {
          toEscalate.push(`task ${i + 1}`);
          detail(`worker ${runId} → verdict: escalate (${result.reason})`);
        }
      }
      ok(`${accepted} worker(s) accepted and pulled; ${toEscalate.length} to escalate`);

      step("escalate_task: rejected/overlapping work re-runs on the cloud target, governed");
      for (const task of toEscalate) {
        const escalated = (await escalate(
          { task: `redo ${task} authoritatively`, reason: "overlapped a pulled worker" },
          CTX
        )) as EscalateOutput;
        if (escalated.budgetExceeded) {
          detail(`escalation budget reached: ${escalated.reason}`);
          break;
        }
        ok(
          `escalated ${task} → run ${escalated.runId} ${escalated.status} ` +
            `(receipt verified: ${escalated.receipt?.verified ?? false})`
        );
      }

      step("every governed run the orchestrator drove, with its receipt verdict");
      for (const record of swarm.calls()) {
        detail(
          `${record.tool} ${record.runId} → ${record.status}` +
            `${record.verdict ? ` (${record.verdict})` : ""}` +
            `${record.receiptVerified !== undefined ? ` receipt verified: ${record.receiptVerified}` : ""}`
        );
      }

      const summary = await swarm.context.summary();
      detail(
        `summary: ${summary.runs.length} governed run(s), ${summary.pulls} pull(s) onto the workspace of record`
      );
      finale(
        "the orchestration loop stays the harness's own; Warrant governs the boundary — " +
          "every worker a signed run, every overlap caught from receipts, every escalation bounded"
      );
    }
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
