import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

export function registerCompatibilityCommands(program: Command): void {
  const endpoints = program
    .command("endpoints")
    .description("compatibility view of live daemon model endpoints");
  endpoints
    .command("list", { isDefault: true })
    .description("list live endpoint/model ids")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const catalog = await (await routekitClient()).call("models.list", {});
      if (ctx.json) ctx.emit({ endpoints: catalog.models, defaultModel: catalog.defaultModel });
      else for (const model of catalog.models) process.stdout.write(`${model.id}\n`);
    });

  for (const action of ["install", "uninstall"] as const) {
    program
      .command(`${action} [integration]`)
      .description(`compatibility alias for routekit codex ${action}`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (integration: string | undefined) => {
        if (integration !== undefined && integration !== "codex") {
          throw new Error(`only the codex integration is supported; use \`routekit codex ${action}\``);
        }
        throw new Error(
          `use \`routekit codex ${action}${action === "install" ? " --gateway-url <url>" : ""}\``
        );
      });
  }
}
