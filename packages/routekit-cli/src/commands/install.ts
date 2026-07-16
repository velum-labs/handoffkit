import { contextFor } from "@routekit/cli-core";
import { trimTrailingSlashes } from "@routekit/runtime";
import {
  installCodexIntegration,
  uninstallCodexIntegration
} from "@routekit/tool-registry";
import type { CodexInstallOwner } from "@routekit/tool-registry";
import type { Command } from "commander";

import { fetchLiveCatalog } from "../catalog.js";

import { loaded } from "./context.js";

const CODEX_OWNER: CodexInstallOwner = {
  id: "routekit",
  displayName: "RouteKit",
  providerId: "routekit",
  installCommand: "routekit install codex",
  uninstallCommand: "routekit uninstall codex",
  startCommand: "routekit serve"
};

function assertCodex(tool: string): void {
  if (tool !== "codex") throw new Error("supported install target: codex");
}

function codexProfileId(modelId: string, index: number): string {
  return modelId.length > 0 &&
    !modelId.includes("/") &&
    !modelId.includes("\\") &&
    !modelId.startsWith(".")
    ? modelId
    : `routekit-model-${index + 1}`;
}

export function registerInstall(program: Command): void {
  program
    .command("install <tool>")
    .description("install a RouteKit-owned provider and profiles")
    .requiredOption("--gateway-url <url>", "running gateway URL")
    .option("--codex-home <dir>", "Codex home directory")
    .action(
      async (
        tool: string,
        options: { gatewayUrl: string; codexHome?: string },
        command: Command
      ) => {
        assertCodex(tool);
        const ctx = contextFor(command);
        const config = loaded(command).config;
        const catalog = await fetchLiveCatalog(options.gatewayUrl, {
          ...(config.defaultModel !== undefined
            ? { defaultModel: config.defaultModel }
            : {})
        });
        const ids = catalog.models.map((model) => model.id);
        const result = installCodexIntegration({
          gatewayUrl: trimTrailingSlashes(options.gatewayUrl),
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

  program
    .command("uninstall <tool>")
    .description("remove RouteKit-owned tool configuration")
    .option("--codex-home <dir>", "Codex home directory")
    .action((tool: string, options: { codexHome?: string }, command: Command) => {
      assertCodex(tool);
      const ctx = contextFor(command);
      const result = uninstallCodexIntegration({
        ownerId: CODEX_OWNER.id,
        ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {})
      });
      if (ctx.json) ctx.emit(result);
      else if (result.removed) ctx.presenter.success(`removed RouteKit from ${result.configPath}`);
      else ctx.presenter.note(`no RouteKit block found in ${result.configPath}`);
    });
}
