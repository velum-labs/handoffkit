import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { discoverCatalog } from "../catalog.js";
import { writeStateSnapshot } from "../state.js";

import { loaded } from "./context.js";

export function registerModels(program: Command): void {
  program
    .command("models")
    .description("inspect models")
    .command("list", { isDefault: true })
    .description("discover live namespaced model ids")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const catalog = await discoverCatalog(config);
      const models = catalog.models.map((model) => model.id);
      writeStateSnapshot("catalog", "models", {
        updatedAt: new Date().toISOString(),
        defaultModel: catalog.defaultModel,
        models: catalog.models
      });
      if (ctx.json) {
        ctx.emit({
          defaultModel: catalog.defaultModel,
          models,
          catalog: catalog.models
        });
      }
      else for (const model of models) process.stdout.write(`${model}\n`);
    });
}
