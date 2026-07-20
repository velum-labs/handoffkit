import { CliError, contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { discoverCatalog } from "../catalog.js";
import type { LiveCatalog, LiveModel } from "../catalog.js";
import { writeStateSnapshot } from "../state.js";

import { loaded } from "./context.js";

export function registerModels(program: Command): void {
  const modelsCommand = program
    .command("models")
    .description("inspect models");

  function providerFor(model: LiveModel): string {
    return model.provider ?? model.id.split("/", 1)[0] ?? "unknown";
  }

  function saveCatalog(catalog: LiveCatalog): void {
    writeStateSnapshot("catalog", "models", {
      updatedAt: new Date().toISOString(),
      defaultModel: catalog.defaultModel,
      models: catalog.models
    });
  }

  modelsCommand
    .command("list", { isDefault: true })
    .description("discover live namespaced model ids")
    .option("--provider <name>", "only show models from one provider")
    .action(async (options: { provider?: string }, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const catalog = await discoverCatalog(config);
      saveCatalog(catalog);
      const filtered = options.provider === undefined
        ? catalog.models
        : catalog.models.filter((model) => providerFor(model) === options.provider);
      const modelIds = filtered.map((model) => model.id);
      if (ctx.json) {
        ctx.emit({
          defaultModel: catalog.defaultModel,
          models: modelIds,
          catalog: filtered
        });
      } else if (ctx.presenter.interactive) {
        ctx.presenter.table(
          filtered.map((model) => [
            providerFor(model),
            model.id,
            model.id === catalog.defaultModel ? "default" : ""
          ]),
          { head: ["provider", "model", ""] }
        );
      } else {
        for (const model of modelIds) process.stdout.write(`${model}\n`);
      }
    });

  modelsCommand
    .command("info <id>")
    .description("show metadata and capabilities for one live model")
    .action(async (id: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const catalog = await discoverCatalog(loaded(command).config);
      saveCatalog(catalog);
      const model = catalog.models.find((entry) => entry.id === id);
      if (model === undefined) {
        throw new CliError({
          code: "model_not_found",
          message: `model is not in the live catalog: ${id}`,
          tryCommand: "routekit models list"
        });
      }
      const result = {
        ...model,
        provider: providerFor(model),
        default: model.id === catalog.defaultModel
      };
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.heading(model.id);
      ctx.presenter.keyValue([
        { label: "provider", value: result.provider },
        { label: "default", value: result.default ? "yes" : "no" },
        {
          label: "capabilities",
          value: Object.entries(model.capabilities)
            .map(([name, value]) => `${name}=${value}`)
            .join(", ") || "not reported"
        },
        ...(model.reasoning !== undefined
          ? [{ label: "reasoning", value: JSON.stringify(model.reasoning) }]
          : [])
      ]);
    });
}
