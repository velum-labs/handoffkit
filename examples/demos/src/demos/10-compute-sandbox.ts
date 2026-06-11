import { rmSync } from "node:fs";

import { governedCompute } from "@warrant/adapter-compute";
import { makeRepo, startStack } from "@warrant/testkit";

import { banner, detail, finale, ok, step } from "../narrate.js";
import type { Demo } from "../registry.js";

export const demo: Demo = {
  id: "10",
  title: "ComputeSDK-shaped sandbox over governed sessions",
  summary:
    "The sandbox shape developers already write — create, runCommand, filesystem — where every command is a signed contract with a receipt, and continuity flows through the workspace.",
  async run() {
    banner(this.id, this.title, this.summary);

    step("boot a plane + runner (pool: eng-prod), command harness allowed");
    const stack = await startStack({
      pool: "eng-prod",
      startRunner: true,
      policy: (policy) => {
        policy.agents.allow = ["command"];
      }
    });
    const repo = makeRepo({ files: { "README.md": "# scratch workspace\n" } });
    try {
      step("compute.sandbox.create() — the familiar shape");
      const compute = governedCompute({
        workspace: repo,
        plane: { url: stack.planeUrl, adminToken: stack.adminToken },
        pool: "eng-prod",
        actor: { kind: "human", id: "dana@example.com" }
      });
      const sandbox = await compute.sandbox.create();
      ok(`sandbox ${sandbox.sandboxId} bound to the workspace`);

      step("stage an input file, then run commands that build on each other");
      await sandbox.filesystem.writeFile(
        "task.md",
        "## task\nsummarize the quarterly numbers\n"
      );
      const first = await sandbox.runCommand("wc -l task.md > stats.txt && cat stats.txt");
      detail(`runCommand #1 → exit ${first.exitCode}: ${first.output.trim()}`);

      const second = await sandbox.runCommand(
        "cat stats.txt && echo 'analysis: looks quarterly' >> report.txt && cat report.txt"
      );
      detail(`runCommand #2 → exit ${second.exitCode}: ${second.output.trim().replace(/\n/g, " | ")}`);
      ok("the second command saw the first command's output: continuity via the workspace");

      const report = await sandbox.filesystem.readFile("report.txt");
      detail(`filesystem.readFile("report.txt") → ${report.trim()}`);

      step("every command is a governed run with its own receipt");
      for (const run of sandbox.runs()) {
        detail(
          `${run.runId}: "${run.command.slice(0, 44)}…" → ${run.status}, receipt verified: ${run.receiptVerified}`
        );
      }

      await sandbox.destroy();
      ok("destroy(): sessions were always ephemeral; the receipts and workspace remain");
      finale(
        "ComputeSDK shape on top, Warrant underneath: same code style, plus contracts and receipts"
      );
    } finally {
      await stack.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }
};
