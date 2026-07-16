import { contextFor, parsePort } from "@routekit/cli-core";
import type { Command } from "commander";

import { startRouter, waitForShutdown } from "../serve.js";

import { loaded } from "./context.js";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("serve the configured model router in the foreground")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "8080")
    .option("--auth-token <token>", "authentication token (required for non-loopback hosts)")
    .option("--no-portless", "disable the stable local route")
    .action(
      async (
        options: {
          host: string;
          port: string;
          authToken?: string;
          portless?: boolean;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const result = loaded(command);
        const running = await startRouter({
          config: result.config,
          host: options.host,
          port: parsePort(options.port, 8080),
          ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {})
        });
        if (ctx.json) {
          ctx.emit({
            url: running.url,
            port: running.gateway.port(),
            config: result.path,
            authenticated: options.authToken !== undefined
          });
        } else {
          ctx.presenter.success(`RouteKit gateway listening at ${running.url}`);
          ctx.presenter.note(`config: ${result.path}`);
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await waitForShutdown();
      }
    );
}
