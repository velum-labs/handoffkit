import type { Command } from "commander";

import { dim, done, note, uiStream } from "@fusionkit/cli-ui";

import { reapFusionServices } from "../shared/portless.js";

import { registerPaletteAction } from "./palette.js";

/** Reap persistent portless singletons (router, dashboard, ...). */
export async function runFusionStop(): Promise<number> {
  const stopped = await reapFusionServices((line) => uiStream().write(`${dim(line)}\n`));
  if (stopped === 0) note("no background fusion services were running");
  else done(`stopped ${stopped} background fusion service(s)`);
  return 0;
}

export function registerStop(program: Command): void {
  registerPaletteAction({
    label: "Stop background fusion services",
    hint: "fusionkit stop",
    argv: ["stop"]
  });
  program
    .command("stop")
    .description("stop background fusion services (router, dashboard, ...)")
    .action(async () => {
      process.exitCode = await runFusionStop();
    });
}
