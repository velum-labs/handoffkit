import { CliError, contextFor } from "@routekit/cli-core";
import type { ModelRouteInfo } from "@routekit/control";
import { ControlError } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isModelRouteInfo(value: unknown): value is ModelRouteInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.provider === "string" &&
    typeof value.nativeModel === "string" &&
    ["api-key", "subscription", "proxy"].includes(String(value.accountClass)) &&
    ["metered-api", "subscription", "upstream-managed"].includes(
      String(value.billingMode)
    ) &&
    typeof value.default === "boolean" &&
    isRecord(value.capabilities) &&
    (value.reasoning === null || isRecord(value.reasoning))
  );
}

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
        if (!(error instanceof ControlError) || error.code !== "not_found") throw error;
        throw new CliError({
          code: "model_not_found",
          message: `model is not in the live catalog: ${id}`,
          tryCommand: "routekit models list"
        });
      }
      if (!isModelRouteInfo(model)) {
        throw new CliError({
          code: "daemon_upgrade_required",
          message:
            "the running RouteKit daemon does not support the route explanation contract",
          tryCommand: "routekit daemon upgrade --force"
        });
      }
      if (ctx.json) {
        ctx.emit(model);
        return;
      }
      ctx.presenter.heading(model.id);
      ctx.presenter.keyValue([
        { label: "provider", value: model.provider },
        { label: "native model", value: model.nativeModel },
        { label: "account class", value: model.accountClass },
        { label: "billing mode", value: model.billingMode },
        { label: "default", value: model.default ? "yes" : "no" },
        {
          label: "capabilities",
          value: Object.entries(model.capabilities ?? {})
            .map(([name, value]) => `${name}=${value}`)
            .join(", ") || "not reported"
        },
        {
          label: "reasoning",
          value: model.reasoning === null ? "not reported" : JSON.stringify(model.reasoning)
        }
      ]);
    });
}
