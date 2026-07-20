import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { stopService } from "../state.js";

export function registerStop(program: Command): void {
  program
    .command("stop")
    .description("stop the RouteKit gateway")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await stopService("gateway");
      if (ctx.json) ctx.emit({ service: result });
      else {
        if (result.stopped) ctx.presenter.success("stopped RouteKit gateway");
        else ctx.presenter.note("RouteKit gateway is not running");
      }
    });
}
