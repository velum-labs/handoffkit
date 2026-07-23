import { resolve } from "node:path";

import { contextFor } from "@velum-labs/routekit-cli-core";
import { commandOnPath, isLoopbackHost, trimTrailingSlashes } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import { launchTool, routekitToolRegistry } from "../launch.js";
import { routekitClient } from "../client.js";
import {
  isLaunchToolId,
  type LaunchToolId
} from "../launch-support.js";

import {
  registerClaudeIntegration,
  registerCodexIntegration
} from "./install.js";

export function registerLaunchers(program: Command): void {
  for (const integration of routekitToolRegistry
    .list()
    .filter((entry) => isLaunchToolId(entry.id))) {
    const command = program
      .command(integration.id)
      .description(`launch ${integration.displayName} through RouteKit`)
      .argument("[model]", "live namespaced provider/model id")
      .argument("[toolArgs...]", `arguments passed to ${integration.displayName}`)
      .option("--gateway-url <url>", "connect to an existing RouteKit gateway")
      .option("--effort <id>", "opaque reasoning effort for the selected model")
      .option("--auth-token <token>", "gateway authentication token")
      .option("--auth-token-env <name>", "read gateway authentication token from an environment variable")
      .option("--cwd <dir>", "tool working directory");
    if (integration.id === "cursor") {
      command.option("--ide", "launch the desktop integration");
    }
    if (integration.id === "codex") {
      registerCodexIntegration(command);
    }
    if (integration.id === "claude") {
      registerClaudeIntegration(command);
    }
    command.action(
      async (
        model: string | undefined,
        toolArgs: string[],
        options: {
          gatewayUrl?: string;
          authToken?: string;
          authTokenEnv?: string;
          cwd?: string;
          effort?: string;
          ide?: boolean;
        },
        actionCommand: Command
      ) => {
        if (contextFor(actionCommand).json) {
          throw new Error(
            `\`${integration.id}\` is interactive and does not support --json`
          );
        }
        if (
          integration.binary !== undefined &&
          !commandOnPath(integration.binary)
        ) {
          throw new Error(
            `routekit preflight failed: "${integration.binary}" was not found on PATH — ` +
              (integration.installHint ?? `install ${integration.binary}`)
          );
        }
        const cwd = options.cwd !== undefined ? resolve(options.cwd) : process.cwd();
        const externalToken =
          options.authTokenEnv !== undefined
            ? process.env[options.authTokenEnv]
            : options.authToken;
        if (options.authTokenEnv !== undefined && externalToken === undefined) {
          throw new Error(`credential environment variable is not set: ${options.authTokenEnv}`);
        }
        if (options.gatewayUrl !== undefined && externalToken !== undefined) {
          const external = new URL(options.gatewayUrl);
          if (external.protocol !== "https:" && !isLoopbackHost(external.hostname)) {
            throw new Error("authenticated external gateways require HTTPS");
          }
        }
        const tool = integration.id as LaunchToolId;
        const prepared =
          options.gatewayUrl === undefined
            ? await (await routekitClient()).call("launcher.prepare", {
                tool,
                ...(model !== undefined ? { model } : {}),
                cwd
              })
            : undefined;
        process.exitCode = await launchTool({
          tool: integration.id,
          gatewayUrl:
            options.gatewayUrl !== undefined
              ? trimTrailingSlashes(options.gatewayUrl)
              : prepared!.gatewayUrl,
          ...(prepared?.model !== undefined
            ? { model: prepared.model }
            : model !== undefined
              ? { model }
              : {}),
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          args: toolArgs,
          cwd,
          ...((options.gatewayUrl !== undefined
            ? externalToken
            : prepared?.authToken) !== undefined
            ? {
                authToken:
                  options.gatewayUrl !== undefined
                    ? externalToken
                    : prepared?.authToken
              }
            : {}),
          ...(integration.id === "cursor" && options.ide !== undefined
            ? { ide: options.ide }
            : {})
        });
      }
    );
  }
}
