import { contextFor, parsePort } from "@routekit/cli-core";
import { startRouteKitDaemon } from "@routekit/daemon";
import type { Command } from "commander";

import { globalRouterConfigPath } from "../config.js";
import { waitForShutdown } from "../serve.js";
import { routekitVersion } from "../state.js";

import { configOverride } from "./context.js";
import { attachServeOptions, drainGraceMs } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";

export function registerServe(program: Command): void {
  attachServeOptions(
    program
      .command("serve")
      .description("serve the configured model router in the foreground")
  )
    .action(
      async (
        options: GatewayServeCliOptions,
        command: Command
      ) => {
        const ctx = contextFor(command);
        const configPath = configOverride(command) ?? globalRouterConfigPath();
        const running = await startRouteKitDaemon({
          packageVersion: routekitVersion(),
          configPath,
          host: options.host,
          port: parsePort(options.port, 8080),
          drainGraceMs: drainGraceMs(options.drainGrace),
          ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {})
        });
        if (ctx.json) {
          ctx.emit({
            event: "listening",
            url: running.dataUrl,
            controlUrl: running.controlUrl,
            port: running.record.dataPort,
            config: configPath,
            authenticated: true,
            pid: running.record.pid,
            generation: running.record.generation
          });
        } else {
          ctx.presenter.success(`RouteKit daemon gateway listening at ${running.dataUrl}`);
          ctx.presenter.note(`control: ${running.controlUrl}`);
          ctx.presenter.note(`config: ${configPath}`);
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await waitForShutdown();
      }
    );
}
