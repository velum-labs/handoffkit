import { contextFor } from "@routekit/cli-core";
import {
  isLoopbackHost,
  trimTrailingSlashes
} from "@routekit/runtime";
import {
  installClaudeIntegration,
  installCodexIntegration,
  uninstallClaudeIntegration,
  uninstallCodexIntegration
} from "@routekit/tool-registry";
import type {
  ClaudeInstallOwner,
  CodexInstallOwner
} from "@routekit/tool-registry";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

const CODEX_OWNER: CodexInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  providerId: "routekit",
  installCommand: "routekit codex install",
  uninstallCommand: "routekit codex uninstall",
  startCommand: "routekit start"
};

const CLAUDE_OWNER: ClaudeInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  installCommand: "routekit claude install",
  uninstallCommand: "routekit claude uninstall",
  startCommand: "routekit start"
};

function codexProfileId(modelId: string, index: number): string {
  return modelId.length > 0 &&
    !modelId.includes("/") &&
    !modelId.includes("\\") &&
    !modelId.startsWith(".")
    ? modelId
    : `routekit-model-${index + 1}`;
}

export function claudeInstallTarget(input: {
  preparedGatewayUrl: string;
  preparedAuthToken: string;
  gatewayUrl?: string;
  authTokenEnv?: string;
  env?: NodeJS.ProcessEnv;
}): { gatewayUrl: string; authToken: string } {
  const preparedGatewayUrl = trimTrailingSlashes(input.preparedGatewayUrl);
  if (input.gatewayUrl === undefined) {
    if (input.authTokenEnv !== undefined) {
      throw new Error("--auth-token-env requires --gateway-url");
    }
    return { gatewayUrl: preparedGatewayUrl, authToken: input.preparedAuthToken };
  }

  const gatewayUrl = trimTrailingSlashes(input.gatewayUrl);
  const parsed = new URL(gatewayUrl);
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("external Claude gateways require HTTPS");
  }
  if (gatewayUrl === preparedGatewayUrl && input.authTokenEnv === undefined) {
    return { gatewayUrl, authToken: input.preparedAuthToken };
  }
  if (input.authTokenEnv === undefined) {
    throw new Error(
      "an overridden Claude gateway requires --auth-token-env; " +
        "the local daemon token will not be forwarded"
    );
  }
  const authToken = (input.env ?? process.env)[input.authTokenEnv];
  if (authToken === undefined || authToken.length === 0) {
    throw new Error(`credential environment variable is not set: ${input.authTokenEnv}`);
  }
  return { gatewayUrl, authToken };
}

export function registerCodexIntegration(codex: Command): void {
  codex
    .command("install")
    .description("install a RouteKit-owned Codex provider and profiles")
    .option("--gateway-url <url>", "override the singleton daemon gateway URL")
    .option("--codex-home <dir>", "Codex home directory")
    .action(
      async (
        options: { gatewayUrl?: string; codexHome?: string },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const client = await routekitClient();
        const [daemon, catalog] = await Promise.all([
          client.call("daemon.status", {}),
          client.call("models.list", {})
        ]);
        const ids = catalog.models.map((model) => model.id);
        const result = installCodexIntegration({
          gatewayUrl: trimTrailingSlashes(options.gatewayUrl ?? daemon.dataUrl),
          profiles: ids.map((modelId, index) => ({
            modelId,
            profileId: codexProfileId(modelId, index)
          })),
          owner: CODEX_OWNER,
          ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
        });
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`${result.action} RouteKit in ${result.configPath}`);
      }
    );

  codex
    .command("uninstall")
    .description("remove RouteKit-owned Codex configuration")
    .option("--codex-home <dir>", "Codex home directory")
    .action(async (options: { codexHome?: string }, command: Command) => {
      const ctx = contextFor(command);
      // Even though the external Codex file mutation is intentionally local,
      // every product command first negotiates with the singleton daemon.
      await (await routekitClient()).call("daemon.status", {});
      const result = uninstallCodexIntegration({
        ownerId: CODEX_OWNER.id,
        ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
      });
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit block found in ${result.configPath}`);
    });
}

export function registerClaudeIntegration(claude: Command): void {
  claude
    .command("install")
    .description("install RouteKit-owned Claude Code gateway settings")
    .option("--gateway-url <url>", "override the singleton daemon gateway URL")
    .option(
      "--auth-token-env <name>",
      "read an overridden gateway token from an environment variable"
    )
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .action(
      async (
        options: {
          gatewayUrl?: string;
          authTokenEnv?: string;
          claudeConfigDir?: string;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        const client = await routekitClient();
        const prepared = await client.call("launcher.prepare", {
          tool: "claude",
          cwd: process.cwd()
        });
        if (prepared.authToken === undefined) {
          throw new Error("the RouteKit daemon did not provide a Claude gateway token");
        }
        const target = claudeInstallTarget({
          preparedGatewayUrl: prepared.gatewayUrl,
          preparedAuthToken: prepared.authToken,
          ...(options.gatewayUrl !== undefined
            ? { gatewayUrl: options.gatewayUrl }
            : {}),
          ...(options.authTokenEnv !== undefined
            ? { authTokenEnv: options.authTokenEnv }
            : {})
        });
        const result = await installClaudeIntegration({
          gatewayUrl: target.gatewayUrl,
          authToken: target.authToken,
          owner: CLAUDE_OWNER,
          ...(options.claudeConfigDir !== undefined
            ? { claudeConfigDir: options.claudeConfigDir }
            : {})
        });
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`${result.action} RouteKit in ${result.configPath}`);
      }
    );

  claude
    .command("uninstall")
    .description("remove RouteKit-owned Claude Code gateway settings")
    .option("--claude-config-dir <dir>", "Claude Code configuration directory")
    .action(async (options: { claudeConfigDir?: string }, command: Command) => {
      const ctx = contextFor(command);
      await (await routekitClient()).call("daemon.status", {});
      const result = await uninstallClaudeIntegration({
        ownerId: CLAUDE_OWNER.id,
        ...(options.claudeConfigDir !== undefined
          ? { claudeConfigDir: options.claudeConfigDir }
          : {})
      });
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit settings found in ${result.configPath}`);
    });
}
