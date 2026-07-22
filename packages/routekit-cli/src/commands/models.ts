import { CliError, contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

export function registerModels(program: Command): void {
  const modelsCommand = program
    .command("models")
    .description("inspect models");

  function providerFor(model: { id: string; provider?: string }): string {
    return model.provider ?? model.id.split("/", 1)[0] ?? "unknown";
  }

  function shouldRenderTable(): boolean {
    return process.stdout.isTTY === true;
  }

  modelsCommand
    .command("list", { isDefault: true })
    .description("discover live namespaced model ids")
    .option("--provider <name>", "only show models from one provider")
    .action(async (options: { provider?: string }, command: Command) => {
      const ctx = contextFor(command);
      const catalog = await (await routekitClient()).call("models.list", {
        ...(options.provider !== undefined ? { provider: options.provider } : {})
      });
      const filtered = catalog.models;
      const modelIds = filtered.map((model) => model.id);
      if (ctx.json) {
        ctx.emit({
          defaultModel: catalog.defaultModel,
          models: modelIds,
          catalog: filtered
        });
      } else if (shouldRenderTable()) {
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
      let model;
      try {
        model = await (await routekitClient()).call("models.info", { model: id });
      } catch (error) {
        throw new CliError({
          code: "model_not_found",
          message: `model is not in the live catalog: ${id}`,
          tryCommand: "routekit models list"
        });
      }
      const catalog = await (await routekitClient()).call("models.list", {});
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
          value: Object.entries(model.capabilities ?? {})
            .map(([name, value]) => `${name}=${value}`)
            .join(", ") || "not reported"
        },
        ...(model.reasoning !== undefined
          ? [{ label: "reasoning", value: JSON.stringify(model.reasoning) }]
          : [])
      ]);
    });
}
