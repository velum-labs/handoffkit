/**
 * The hidden `__complete` protocol behind dynamic shell completion. Shell
 * shims (see `completion.ts`) call
 *
 *   fusionkit __complete -- <words...>
 *
 * with the words typed so far (the last one possibly partial) and print the
 * returned candidates, one per line. Candidates come from the live Commander
 * tree (subcommands, long flags) plus dynamic values read from local state —
 * stored session ids, configured ensemble names, settable config paths, the
 * local model catalog — so completion always matches this machine. Reads are
 * local-disk only (never the network) and every failure degrades to an empty
 * list: completion must never break the shell.
 */
import { Command } from "commander";

import { defaultSessionsDir, FileSystemSessionStore } from "@fusionkit/model-gateway";

import { loadFusionConfig, PROMPT_IDS } from "../fusion-config.js";
import { cachedCatalog } from "../fusion/catalog.js";
import { persistedShape, repoRootFor, shapeEnsembles } from "../fusion/config-store.js";
import { detectHost, recommendFor } from "../fusion/local-catalog.js";

import { settableConfigPaths } from "./config.js";

const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

function attempt<T>(produce: () => T, fallback: T): T {
  try {
    return produce();
  } catch {
    return fallback;
  }
}

function sessionIds(): string[] {
  return attempt(() => new FileSystemSessionStore(defaultSessionsDir()).list().map((session) => session.id), []);
}

function ensembleNames(): string[] {
  return attempt(() => {
    const { root } = repoRootFor({});
    const config = loadFusionConfig(root);
    return Object.keys(shapeEnsembles(persistedShape(config)));
  }, []);
}

function configPaths(): string[] {
  return attempt(() => {
    const { root } = repoRootFor({});
    const config = loadFusionConfig(root);
    return settableConfigPaths(config).map((entry) => entry.path);
  }, []);
}

function localModelRepos(): string[] {
  // Curated first, then any cached mlx-community entries (cache only — shell
  // completion must never hit the network).
  return attempt(() => {
    const curated = recommendFor(detectHost()).map((entry) => entry.repo);
    const community = cachedCatalog("mlx").map((model) => model.id);
    return [...new Set([...curated, ...community])];
  }, []);
}

/**
 * Dynamic positional values by command path. `depth` is how many argument
 * words already follow the subcommand (0 = completing the first argument).
 */
function dynamicArgumentValues(path: readonly string[], depth: number): string[] | undefined {
  const [group, sub] = path;
  if (group === "sessions" && (sub === "show" || sub === "rm" || sub === "remove") && depth === 0) {
    return sessionIds();
  }
  if (group === "ensemble" && depth === 0) {
    if (sub === "edit" || sub === "remove" || sub === "rm" || sub === "rename") {
      return ensembleNames();
    }
  }
  if (group === "config" && (sub === "get" || sub === "set" || sub === "unset") && depth === 0) {
    return configPaths();
  }
  if (group === "models" && (sub === "download" || sub === "rm" || sub === "remove") && depth === 0) {
    return localModelRepos();
  }
  if (group === "prompts" && (sub === "edit" || sub === "reset") && depth === 0) {
    return [...PROMPT_IDS];
  }
  if (group === "completion" && depth === 0 && sub === undefined) {
    return [...COMPLETION_SHELLS];
  }
  return undefined;
}

/** The visible (non-hidden, non-help) subcommand names + aliases of `command`. */
function subcommandNames(command: Command): string[] {
  const names: string[] = [];
  for (const sub of command.commands) {
    const name = sub.name();
    if (name === "help" || name.startsWith("__")) continue;
    names.push(name);
    for (const alias of sub.aliases()) names.push(alias);
  }
  return names;
}

/** The long flags of `command` plus its ancestors' global flags. */
function longFlags(command: Command): string[] {
  const flags = new Set<string>();
  let current: Command | null = command;
  while (current !== null) {
    for (const option of current.options) {
      if (option.long !== undefined && option.long !== null && !option.hidden) flags.add(option.long);
    }
    current = current.parent;
  }
  return [...flags];
}

/**
 * Compute completion candidates for the typed words (last word partial).
 * Exported for tests.
 */
export function completionCandidates(program: Command, words: readonly string[]): string[] {
  const typed = [...words];
  const current = typed.pop() ?? "";

  // Walk the command tree along the fully-typed words, tracking the resolved
  // command node, the command-name path, and how many non-flag argument words
  // follow the deepest command.
  let node: Command = program;
  const path: string[] = [];
  let argumentDepth = 0;
  for (const word of typed) {
    if (word.startsWith("-")) continue;
    const next = node.commands.find((sub) => sub.name() === word || sub.aliases().includes(word));
    if (next !== undefined) {
      node = next;
      path.push(next.name());
      argumentDepth = 0;
    } else {
      argumentDepth += 1;
    }
  }

  let candidates: string[];
  if (current.startsWith("-")) {
    candidates = longFlags(node);
  } else {
    const dynamic = dynamicArgumentValues(path, argumentDepth);
    candidates = [...subcommandNames(node), ...(dynamic ?? [])];
    // Anywhere in a `fusion`/launcher context with no subcommands and no
    // dynamic values there is nothing useful to offer (tool args pass through).
  }
  const unique = [...new Set(candidates)];
  return unique.filter((candidate) => candidate.startsWith(current)).sort((a, b) => a.localeCompare(b));
}

/** Register the hidden `__complete` command (the shell shims' data source). */
export function registerComplete(program: Command): void {
  const complete = new Command("__complete")
    .description("internal: print completion candidates for the typed words")
    .argument("[words...]", "the command line so far (after `fusionkit`)")
    .allowUnknownOption()
    .helpOption(false)
    .action((words: string[]) => {
      const candidates = attempt(() => completionCandidates(program, words), []);
      process.stdout.write(candidates.map((candidate) => `${candidate}\n`).join(""));
    });
  program.addCommand(complete, { hidden: true });
}
