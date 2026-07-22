import { Command } from "commander";

import { completionCandidates as coreCompletionCandidates } from "@routekit/cli-core";
import { configuredProviderIds } from "@routekit/config";
import { PROVIDER_IDS } from "@routekit/gateway";
import { accountKinds } from "@routekit/registry";

import { listAccounts } from "./accounts.js";
import { globalRouterConfigPath, loadRouterConfig } from "./config.js";
import { readStateSnapshot } from "./state.js";

function providerIds(): string[] {
  try {
    return configuredProviderIds(
      loadRouterConfig({ configPath: globalRouterConfigPath() }).config
    );
  } catch {
    return [];
  }
}

function modelIds(): string[] {
  const snapshot = readStateSnapshot("catalog", "models");
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return [];
  }
  const models = (snapshot as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model === "string") return [model];
    if (
      typeof model === "object" &&
      model !== null &&
      !Array.isArray(model) &&
      typeof (model as { id?: unknown }).id === "string"
    ) {
      return [(model as { id: string }).id];
    }
    return [];
  });
}

function dynamicValues(
  path: readonly string[],
  argumentDepth: number,
  positional: readonly string[]
): string[] {
  const [group, subcommand] = path;
  if (
    group === "providers" &&
    (subcommand === "remove" || subcommand === "status") &&
    argumentDepth === 0
  ) {
    return providerIds();
  }
  if (
    group === "providers" &&
    subcommand === "add" &&
    argumentDepth === 0
  ) {
    const configured = new Set(providerIds());
    return PROVIDER_IDS.filter((provider) => !configured.has(provider));
  }
  if (
    (group === "codex" ||
      group === "claude" ||
      group === "cursor" ||
      group === "opencode") &&
    argumentDepth === 0
  ) {
    return modelIds();
  }
  if (group === "accounts" && subcommand === "add" && argumentDepth === 0) {
    return ["claude-code", "codex"];
  }
  if (
    group === "accounts" &&
    (subcommand === "login" || subcommand === "remove") &&
    argumentDepth === 0
  ) {
    return [...accountKinds()];
  }
  if (group === "accounts" && subcommand === "remove" && argumentDepth === 1) {
    const subscriptionKind =
      positional[0] === "claude" ? "claude-code" : positional[0];
    return listAccounts()
      .filter((entry) => entry.subscriptionKind === subscriptionKind)
      .map((entry) => entry.label);
  }
  if (group === "completion" && argumentDepth === 0) return ["bash", "zsh", "fish"];
  return [];
}

export function completionCandidates(program: Command, words: readonly string[]): string[] {
  return coreCompletionCandidates(program, words, dynamicValues);
}

export function registerDynamicCompletion(program: Command): void {
  const complete = new Command("__complete")
    .description("internal completion protocol")
    .argument("[words...]")
    .allowUnknownOption()
    .helpOption(false)
    .action((words: string[]) => {
      process.stdout.write(
        completionCandidates(program, words)
          .map((candidate) => `${candidate}\n`)
          .join("")
      );
    });
  program.addCommand(complete, { hidden: true });
}
