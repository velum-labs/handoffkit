/**
 * Demo series dispatcher.
 *
 *   pnpm demo            list the series
 *   pnpm demo 01         run one demo
 *   pnpm demo all        run every non-interactive demo in order
 */
import { demo as governedRun } from "./demos/01-governed-run.js";
import { demo as dryRun } from "./demos/02-dry-run.js";
import { demo as consentAndSecrets } from "./demos/03-consent-and-secrets.js";
import { demo as egressPolicy } from "./demos/04-egress-policy.js";
import { demo as offlineVerify } from "./demos/05-offline-verify.js";
import { demo as handoffDemo } from "./demos/06-handoff.js";
import { demo as parallelFanout } from "./demos/07-parallel-fanout.js";
import { demo as controlPanel } from "./demos/08-control-panel.js";
import { demo as aiSdkLoop } from "./demos/09-ai-sdk-loop.js";
import { demo as computeSandbox } from "./demos/10-compute-sandbox.js";
import { bold, dim } from "./narrate.js";
import type { Demo } from "./registry.js";

const SERIES: Demo[] = [
  governedRun,
  dryRun,
  consentAndSecrets,
  egressPolicy,
  offlineVerify,
  handoffDemo,
  parallelFanout,
  controlPanel,
  aiSdkLoop,
  computeSandbox
];

function list(): void {
  console.log(bold("warrant demo series"));
  console.log("");
  for (const demo of SERIES) {
    console.log(
      `  ${bold(demo.id)}  ${demo.title}${demo.interactive ? dim("  (interactive)") : ""}`
    );
    console.log(`      ${dim(demo.summary)}`);
  }
  console.log("");
  console.log(`run one:  ${bold("pnpm demo 01")}`);
  console.log(`run all:  ${bold("pnpm demo all")} ${dim("(skips interactive demos)")}`);
}

async function main(): Promise<void> {
  const selector = process.argv[2];
  if (!selector || selector === "list") {
    list();
    return;
  }
  if (selector === "all") {
    for (const demo of SERIES) {
      if (demo.interactive) continue;
      await demo.run();
    }
    return;
  }
  const demo = SERIES.find((d) => d.id === selector || d.id === selector.padStart(2, "0"));
  if (!demo) {
    console.error(`unknown demo "${selector}"`);
    list();
    process.exit(1);
  }
  await demo.run();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
