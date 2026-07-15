import { Command } from "commander";

import { listAccounts } from "./accounts.js";
import { loadRouterConfig } from "./config.js";

function visibleSubcommands(command: Command): string[] {
  return command.commands
    .filter((entry) => entry.name() !== "help" && !entry.name().startsWith("__"))
    .map((entry) => entry.name());
}

function longFlags(command: Command): string[] {
  const flags = new Set<string>();
  let current: Command | null = command;
  while (current !== null) {
    for (const option of current.options) {
      if (option.long !== undefined && !option.hidden) flags.add(option.long);
    }
    current = current.parent;
  }
  return [...flags];
}

function endpointIds(): string[] {
  try {
    return [...new Set(loadRouterConfig().config.endpoints.map((entry) => entry.endpointId))];
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
    return ["claude", "codex"];
  }
  if (group === "accounts" && subcommand === "remove" && argumentDepth === 1) {
    const provider = positional[0] === "claude" ? "claude-code" : positional[0];
    return listAccounts()
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.label);
  }
  if (group === "completion" && argumentDepth === 0) return ["bash", "zsh", "fish"];
  return [];
}

export function completionCandidates(program: Command, words: readonly string[]): string[] {
  const typed = [...words];
  const currentWord = typed.pop() ?? "";
  let node = program;
  const path: string[] = [];
  const positional: string[] = [];
  let argumentDepth = 0;
  for (const word of typed) {
    if (word.startsWith("-")) continue;
    const next = node.commands.find((entry) => entry.name() === word);
    if (next !== undefined) {
      node = next;
      path.push(next.name());
      argumentDepth = 0;
    } else {
      positional.push(word);
      argumentDepth += 1;
    }
  }
  const candidates = currentWord.startsWith("-")
    ? longFlags(node)
    : [...visibleSubcommands(node), ...dynamicValues(path, argumentDepth, positional)];
  return [...new Set(candidates)]
    .filter((candidate) => candidate.startsWith(currentWord))
    .sort((left, right) => left.localeCompare(right));
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
