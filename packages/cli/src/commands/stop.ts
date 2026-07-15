import type { Command } from "commander";

import { dim, done, note, uiStream } from "@fusionkit/cli-ui";

import { stopProxy } from "../fusion/subscription-proxy.js";
import { reapFusionServices } from "../shared/portless.js";

import { registerPaletteAction } from "./palette.js";

/** Reap persistent fusion services, including the subscription proxy. */
export async function runFusionStop(): Promise<number> {
  const log = (line: string): void => {
    uiStream().write(`${dim(line)}\n`);
  };
  const proxy = await stopProxy(log);
  const stoppedServices = await reapFusionServices(log);
  const stopped = stoppedServices + (proxy.stopped ? 1 : 0);
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
    .description("stop all background fusion services (router, dashboard, subscription proxy, ...)")
    .action(async () => {
      process.exitCode = await runFusionStop();
    });
}
