import { resolve } from "node:path";

import { contextFor, parsePort } from "@routekit/cli-core";
import { trimTrailingSlashes } from "@routekit/runtime";
import type { Command } from "commander";

import { launchTool, routekitToolRegistry } from "../launch.js";

import { loaded } from "./context.js";

export function registerLaunchers(program: Command): void {
  for (const integration of routekitToolRegistry.list()) {
    const command = program
      .command(integration.id)
      .description(`launch ${integration.displayName} through RouteKit`)
      .argument("[model]", "configured endpoint id")
      .argument("[toolArgs...]", `arguments passed to ${integration.displayName}`)
      .option("--gateway-url <url>", "connect to an existing RouteKit gateway")
      .option("--host <host>", "embedded gateway bind host", "127.0.0.1")
      .option("--port <port>", "embedded gateway bind port", "0")
      .option("--auth-token <token>", "gateway authentication token")
      .option("--cwd <dir>", "tool working directory");
    if (integration.id === "cursor") {
      command.option("--ide", "launch the desktop integration");
    }
    command.action(
      async (
        model: string | undefined,
        toolArgs: string[],
        options: {
          gatewayUrl?: string;
          host: string;
          port: string;
          authToken?: string;
          cwd?: string;
          ide?: boolean;
        },
        actionCommand: Command
      ) => {
        if (contextFor(actionCommand).json) {
          throw new Error(
            `\`${integration.id}\` is interactive and does not support --json`
          );
        }
        const config = loaded(actionCommand).config;
        process.exitCode = await launchTool({
          tool: integration.id,
          config,
          ...(options.gatewayUrl !== undefined
            ? { gatewayUrl: trimTrailingSlashes(options.gatewayUrl) }
            : {}),
          ...(model !== undefined ? { model } : {}),
          args: toolArgs,
          ...(options.cwd !== undefined ? { cwd: resolve(options.cwd) } : {}),
          ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
          host: options.host,
          port: parsePort(options.port, 0),
          ...(integration.id === "cursor" && options.ide !== undefined
            ? { ide: options.ide }
            : {})
        });
      }
    );
  }
}
