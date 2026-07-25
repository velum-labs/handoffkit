import { Command } from "commander";

import { completionCandidates as coreCompletionCandidates } from "@velum-labs/routekit-cli-core";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";

import { listAccounts } from "./accounts.js";
import { globalRouterConfigPath, loadRouterConfig } from "./config.js";
import {
  isLaunchAccountKind,
  isLaunchToolId,
  LAUNCH_ACCOUNT_KIND_CHOICES,
  LAUNCH_PROVIDER_IDS
} from "./launch-support.js";
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
    return LAUNCH_PROVIDER_IDS.filter((provider) => !configured.has(provider));
  }
  if (
    group !== undefined &&
    isLaunchToolId(group) &&
    argumentDepth === 0
  ) {
    return modelIds();
  }
  if (group === "accounts" && subcommand === "add" && argumentDepth === 0) {
    return [...LAUNCH_ACCOUNT_KIND_CHOICES];
  }
  if (
    group === "accounts" &&
    (subcommand === "login" || subcommand === "rename") &&
    argumentDepth === 0
  ) {
    return [...LAUNCH_ACCOUNT_KIND_CHOICES];
  }
  if (
    group === "accounts" &&
    subcommand === "remove" &&
    argumentDepth === 0
  ) {
    return [
      ...new Set([
        ...LAUNCH_ACCOUNT_KIND_CHOICES,
        ...listAccounts()
          .map((entry) => entry.subscriptionKind)
          .filter((kind) => {
            const resolved = resolveAccountConnector(kind);
            return isLaunchAccountKind(resolved?.kind ?? kind);
          })
      ])
    ];
  }
  if (group === "accounts" && subcommand === "remove" && argumentDepth === 1) {
    const suppliedKind = positional[0] ?? "";
    const resolved = resolveAccountConnector(suppliedKind);
    const kind = resolved?.kind ?? suppliedKind;
    if (!isLaunchAccountKind(kind)) return [];
    return listAccounts()
      .filter((entry) => {
        if (entry.subscriptionKind === kind) return true;
        return (
          resolved !== undefined &&
          resolveAccountConnector(entry.subscriptionKind)?.kind === resolved.kind
        );
      })
      .map((entry) => entry.label);
  }
  if (group === "accounts" && subcommand === "rename" && argumentDepth === 1) {
    const suppliedKind = positional[0] ?? "";
    const resolved = resolveAccountConnector(suppliedKind);
    if (resolved?.info.connector !== "native" || !isLaunchAccountKind(resolved.kind)) {
      return [];
    }
    return listAccounts()
      .filter(
        (entry) =>
          entry.connector === "native" &&
          entry.subscriptionKind === resolved.kind
      )
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
