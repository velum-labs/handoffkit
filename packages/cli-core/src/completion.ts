import type { Command } from "commander";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
type CommandNode = { names: string[]; subcommands: string[] };
export type CompletionWalk = {
  command: Command;
  path: string[];
  positional: string[];
  argumentDepth: number;
  currentWord: string;
};
export type CompletionValueProvider = (
  path: readonly string[],
  argumentDepth: number,
  positional: readonly string[]
) => readonly string[] | undefined;

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

function visible(commands: readonly Command[]): Command[] {
  return commands.filter(
    (command) =>
      command.name() !== "help" &&
      !command.name().startsWith("__") &&
      (command as Command & { _hidden?: boolean })._hidden !== true
  );
}

/** Visible canonical command names and aliases, in Commander registration order. */
export function visibleCommandNames(command: Command): string[] {
  return visible(command.commands).flatMap((entry) => [entry.name(), ...entry.aliases()]);
}

/** Long options on a command plus inherited global options. */
export function visibleLongFlags(command: Command): string[] {
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

/** De-duplicate, prefix-filter, and sort completion candidates. */
export function filterCompletionCandidates(
  candidates: readonly string[],
  currentWord: string
): string[] {
  return [...new Set(candidates)]
    .filter((candidate) => candidate.startsWith(currentWord))
    .sort((left, right) => left.localeCompare(right));
}

/** Resolve fully typed words against a Commander tree, including aliases. */
export function walkCompletionTree(program: Command, words: readonly string[]): CompletionWalk {
  const typed = [...words];
  const currentWord = typed.pop() ?? "";
  let command = program;
  const path: string[] = [];
  const positional: string[] = [];
  let argumentDepth = 0;
  for (const word of typed) {
    if (word.startsWith("-")) continue;
    const next = command.commands.find(
      (entry) => entry.name() === word || entry.aliases().includes(word)
    );
    if (next !== undefined) {
      command = next;
      path.push(next.name());
      argumentDepth = 0;
    } else {
      positional.push(word);
      argumentDepth += 1;
    }
  }
  return { command, path, positional, argumentDepth, currentWord };
}

/** Filter static and caller-provided dynamic candidates for the current word. */
export function completionCandidates(
  program: Command,
  words: readonly string[],
  dynamicValues?: CompletionValueProvider
): string[] {
  const state = walkCompletionTree(program, words);
  const candidates = state.currentWord.startsWith("-")
    ? visibleLongFlags(state.command)
    : [
        ...visibleCommandNames(state.command),
        ...(dynamicValues?.(state.path, state.argumentDepth, state.positional) ?? [])
      ];
  return filterCompletionCandidates(candidates, state.currentWord);
}

function commandNodes(program: Command): CommandNode[] {
  return visible(program.commands).map((command) => ({
    names: [command.name(), ...command.aliases()],
    subcommands: visibleCommandNames(command)
  }));
}

const words = (values: readonly string[]): string => values.join(" ");
const topLevelNames = (nodes: readonly CommandNode[]): string[] =>
  nodes.flatMap((node) => node.names);

function bashCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const dynamic = `${binary} __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null`;
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.names.join("|")}) COMPREPLY=( $(compgen -W "${words(node.subcommands)}" -- "$cur") ); return ;;`
    )
    .join("\n");
  return [
    `# bash completion for ${binary}`,
    `_${binary}_completion() {`,
    "  local cur dynamic",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  dynamic="$(${dynamic})"`,
    '  if [[ -n "${dynamic}" ]]; then COMPREPLY=( $(compgen -W "${dynamic}" -- "$cur") ); return; fi',
    `  if [[ \${COMP_CWORD} -eq 1 ]]; then COMPREPLY=( $(compgen -W "${words(topLevelNames(nodes))}" -- "$cur") ); return; fi`,
    '  case "${COMP_WORDS[1]}" in',
    cases,
    "  esac",
    "}",
    `complete -F _${binary}_completion ${binary}`,
    ""
  ].join("\n");
}

function zshCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.names.join("|")}) _values '${node.names[0]} command' ${words(node.subcommands)} ;;`
    )
    .join("\n");
  return [
    `#compdef ${binary}`,
    `_${binary}() {`,
    "  local -a dynamic",
    `  dynamic=(\${(f)"$(${binary} __complete -- \${words[@]:1:$((CURRENT-1))} 2>/dev/null)"})`,
    '  if (( ${#dynamic} )); then compadd -- "${dynamic[@]}"; return; fi',
    `  if (( CURRENT == 2 )); then _values '${binary} command' ${words(topLevelNames(nodes))}; return; fi`,
    '  case "$words[2]" in',
    cases,
    "  esac",
    "}",
    `_${binary} "$@"`,
    ""
  ].join("\n");
}

function fishCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const helper = `__${binary}_complete`;
  const lines = [
    `# fish completion for ${binary}`,
    `function ${helper}`,
    "    set -l tokens (commandline -opc) (commandline -ct)",
    `    ${binary} __complete -- $tokens[2..-1] 2>/dev/null`,
    "end",
    `complete -c ${binary} -f -a "(${helper})"`,
    `complete -c ${binary} -f -n "__fish_use_subcommand" -a "${words(topLevelNames(nodes))}"`
  ];
  for (const node of nodes) {
    if (node.subcommands.length > 0) {
      lines.push(
        `complete -c ${binary} -f -n "__fish_seen_subcommand_from ${words(node.names)}" -a "${words(node.subcommands)}"`
      );
    }
  }
  return [...lines, ""].join("\n");
}

export function completionScript(
  shell: CompletionShell,
  binary: string,
  program: Command
): string {
  const nodes = commandNodes(program);
  switch (shell) {
    case "bash":
      return bashCompletion(binary, nodes);
    case "zsh":
      return zshCompletion(binary, nodes);
    case "fish":
      return fishCompletion(binary, nodes);
    default: {
      const exhaustive: never = shell;
      throw new Error(`unsupported shell ${String(exhaustive)}`);
    }
  }
}

export function registerCompletion(program: Command, binary: string): void {
  program
    .command("completion")
    .description("advanced: print a shell completion script")
    .argument("<shell>", COMPLETION_SHELLS.join(" | "))
    .action((shell: string) => {
      if (!isCompletionShell(shell)) {
        throw new Error(`unsupported shell "${shell}" (expected ${COMPLETION_SHELLS.join(" | ")})`);
      }
      process.stdout.write(completionScript(shell, binary, program));
    });
}
