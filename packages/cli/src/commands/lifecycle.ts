import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "commander";

import { verifyReceiptBundle } from "@warrant/protocol";
import type { ReceiptBundle } from "@warrant/protocol";
import { pullRun } from "@warrant/workspace";

import { loadHome } from "../config.js";
import { renderReceipt, renderRunList } from "../render.js";
import { clientFor, resolveDir, waitForTerminal } from "../shared/plane.js";

export function registerLifecycle(program: Command): void {
  const dirOf = (): string => resolveDir(program.opts().dir);

  program
    .command("runs")
    .description("list runs")
    .action(async () => {
      const { runs } = await clientFor(dirOf()).listRuns();
      console.log(renderRunList(runs));
    });

  program
    .command("approve <runId>")
    .description("grant required consent")
    .action(async (runId: string) => {
      const dir = dirOf();
      const home = loadHome(dir);
      const result = await clientFor(dir).approve(runId, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
    });

  program
    .command("cancel <runId>")
    .description("cancel an unclaimed run")
    .action(async (runId: string) => {
      const dir = dirOf();
      const home = loadHome(dir);
      const result = await clientFor(dir).cancel(runId, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
    });

  program
    .command("watch <runId>")
    .description("stream run status")
    .action(async (runId: string) => {
      const status = await waitForTerminal(clientFor(dirOf()), runId, (s) => console.log(s));
      console.log(`final: ${status}`);
    });

  program
    .command("receipt <runId>")
    .description("one screen, five questions")
    .action(async (runId: string) => {
      console.log(renderReceipt(await clientFor(dirOf()).getBundle(runId)));
    });

  program
    .command("bundle <runId>")
    .description("save offline-verifiable bundle")
    .option("--out <file>", "output path")
    .action(async (runId: string, opts: { out?: string }) => {
      const bundle = await clientFor(dirOf()).getBundle(runId);
      const out = opts.out ?? `${runId}.bundle.json`;
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log(`bundle written to ${out}`);
    });

  program
    .command("verify <file>")
    .description("verify a bundle offline")
    .action((file: string) => {
      const bundle = JSON.parse(readFileSync(file, "utf8")) as ReceiptBundle;
      const result = verifyReceiptBundle(bundle);
      if (result.ok) {
        console.log("VERIFIED: signatures, event chain, and linkage all check out");
        return;
      }
      console.error("VERIFICATION FAILED:");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
    });

  program
    .command("pull <runId>")
    .description("divergence-safe pull of results")
    .option("--repo <dir>", "workspace repository", ".")
    .action(async (runId: string, opts: { repo: string }) => {
      const client = clientFor(dirOf());
      const bundle = await client.getBundle(runId);
      const diffHash = bundle.receipt.workspaceOut.diffHash;
      if (!diffHash) {
        console.log("run produced no workspace changes; nothing to pull");
        return;
      }
      const diff = await client.getBlob(diffHash);
      const result = pullRun(
        resolve(opts.repo),
        runId,
        bundle.contract.workspace.baseRef,
        diff
      );
      switch (result.mode) {
        case "applied":
          console.log("applied run output to the working tree (clean fast path)");
          break;
        case "branch":
          console.log(
            `local workspace diverged from the contract base; results are on branch ${result.branch}`
          );
          break;
        case "empty":
          console.log("run produced no workspace changes; nothing to pull");
          break;
        default: {
          const exhausted: never = result;
          throw new Error(`unreachable: ${String(exhausted)}`);
        }
      }
    });

  program
    .command("export")
    .description("audit JSONL export")
    .option("--since <iso>", "only export events at or after this timestamp")
    .action(async (opts: { since?: string }) => {
      process.stdout.write(await clientFor(dirOf()).exportJsonl(opts.since));
    });

  program
    .command("ui")
    .description("control panel URL and login token")
    .action(() => {
      const home = loadHome(dirOf());
      console.log(`control panel: ${home.config.planeUrl}/ui/`);
      console.log(`login token:   ${home.config.adminToken}`);
    });
}
