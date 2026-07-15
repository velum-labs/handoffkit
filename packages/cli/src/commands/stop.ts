import type { Command } from "commander";

import { dim, done, note, uiStream } from "@routekit/cli-ui";

import { reapFusionServices } from "../shared/portless.js";

import { registerPaletteAction } from "./palette.js";

/** Reap only FusionKit-owned portless services. */
export async function runFusionStop(): Promise<number> {
  const log = (line: string): void => {
    uiStream().write(`${dim(line)}\n`);
  };
  const stopped = await reapFusionServices(log);
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
    .description("stop only FusionKit-owned processes and portless routes")
    .action(async () => {
      process.exitCode = await runFusionStop();
    });
}
