import { Command } from "commander";

import { completionCandidates as coreCompletionCandidates } from "@routekit/cli-core";
import { configuredEndpointIds } from "@routekit/config";

import { listAccounts } from "./accounts.js";
import { loadRouterConfig } from "./config.js";

function endpointIds(): string[] {
  try {
    return configuredEndpointIds(loadRouterConfig().config);
  } catch {
    return [];
  }
}

function dynamicValues(
  path: readonly string[],
  argumentDepth: number,
  positional: readonly string[]
): string[] {
  const [group, subcommand] = path;
  if (
    group === "endpoints" &&
    (subcommand === "remove" || subcommand === "health") &&
    argumentDepth === 0
  ) {
    return endpointIds();
  }
  if (
    (group === "codex" ||
      group === "claude" ||
      group === "cursor" ||
      group === "opencode") &&
    argumentDepth === 0
  ) {
    return endpointIds();
  }
  if (
    group === "accounts" &&
    (subcommand === "add" || subcommand === "remove") &&
    argumentDepth === 0
  ) {
    return ["claude-code", "codex"];
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
