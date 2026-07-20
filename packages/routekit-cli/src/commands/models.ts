import { contextFor } from "@routekit/cli-core";
import type { Command } from "commander";

import { discoverCatalog } from "../catalog.js";
import { writeStateSnapshot } from "../state.js";

import { loaded } from "./context.js";

export function registerModels(program: Command): void {
  const modelsCommand = program.command("models").description("inspect models");
  modelsCommand
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

  modelsCommand
    .command("explain <model>")
    .description("explain one namespaced model route and its discovered capabilities")
    .action(async (modelId: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const catalog = await discoverCatalog(config);
      const model = catalog.models.find((candidate) => candidate.id === modelId);
      if (model === undefined) {
        throw new Error(
          `unknown model "${modelId}" (available: ${catalog.models
            .map((candidate) => candidate.id)
            .join(", ")})`
        );
      }
      const separator = model.id.indexOf("/");
      const provider =
        model.provider ?? (separator === -1 ? "unknown" : model.id.slice(0, separator));
      const result = {
        model: model.id,
        provider,
        nativeModel: separator === -1 ? model.id : model.id.slice(separator + 1),
        billingMode:
          provider === "codex" || provider === "claude-code"
            ? "subscription"
            : "api_key",
        configuredDefault: catalog.defaultModel === model.id,
        capabilities: model.capabilities,
        reasoning: model.reasoning ?? null
      };
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.table([
        ["model", result.model],
        ["provider", result.provider],
        ["native model", result.nativeModel],
        ["billing mode", result.billingMode],
        ["configured default", String(result.configuredDefault)],
        ["capabilities", JSON.stringify(result.capabilities)],
        ["reasoning", JSON.stringify(result.reasoning)]
      ]);
    });
}
