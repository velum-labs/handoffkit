import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { writeStateSnapshot } from "../state.js";

import { loaded } from "./context.js";

export function registerModels(program: Command): void {
  program
    .command("models")
    .description("inspect models")
    .command("list", { isDefault: true })
    .description("list configured opaque model ids")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const models = [...new Set(config.endpoints.map((entry) => entry.endpointId))];
      writeStateSnapshot("catalog", "models", {
        updatedAt: new Date().toISOString(),
        defaultModel: config.defaultEndpointId ?? models[0],
        models
      });
      if (ctx.json) ctx.emit({ defaultModel: config.defaultEndpointId ?? models[0], models });
      else for (const model of models) process.stdout.write(`${model}\n`);
    });
}
