import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { stopAllServices } from "../state.js";

export function registerStop(program: Command): void {
  program
    .command("stop")
    .description("stop only RouteKit-owned services")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const results = await stopAllServices();
      if (ctx.json) ctx.emit({ services: results });
      else {
        const stopped = results.filter((result) => result.stopped).length;
        if (stopped > 0) ctx.presenter.success(`stopped ${stopped} RouteKit service(s)`);
        else ctx.presenter.note("no RouteKit services are running");
      }
    });
}
