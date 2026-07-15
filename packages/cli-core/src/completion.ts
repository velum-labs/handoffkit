import type { Command } from "commander";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
type CommandNode = { name: string; subcommands: string[] };

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

function visible(commands: readonly Command[]): Command[] {
  return commands.filter((command) => command.name() !== "help" && !command.name().startsWith("__"));
}

function commandNodes(program: Command): CommandNode[] {
  return visible(program.commands).map((command) => ({
    name: command.name(),
    subcommands: visible(command.commands).map((subcommand) => subcommand.name())
  }));
}

const words = (values: readonly string[]): string => values.join(" ");

function bashCompletion(binary: string, nodes: readonly CommandNode[]): string {
  const dynamic = `${binary} __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null`;
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.name}) COMPREPLY=( $(compgen -W "${words(node.subcommands)}" -- "$cur") ); return ;;`
    )
    .join("\n");
  return [
    `# bash completion for ${binary}`,
    `_${binary}_completion() {`,
    "  local cur dynamic",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  dynamic="$(${dynamic})"`,
    '  if [[ -n "${dynamic}" ]]; then COMPREPLY=( $(compgen -W "${dynamic}" -- "$cur") ); return; fi',
    `  if [[ \${COMP_CWORD} -eq 1 ]]; then COMPREPLY=( $(compgen -W "${words(nodes.map((node) => node.name))}" -- "$cur") ); return; fi`,
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
    .map((node) => `    ${node.name}) _values '${node.name} command' ${words(node.subcommands)} ;;`)
    .join("\n");
  return [
    `#compdef ${binary}`,
    `_${binary}() {`,
    "  local -a dynamic",
    `  dynamic=(\${(f)"$(${binary} __complete -- \${words[@]:1:$((CURRENT-1))} 2>/dev/null)"})`,
    '  if (( ${#dynamic} )); then compadd -- "${dynamic[@]}"; return; fi',
    `  if (( CURRENT == 2 )); then _values '${binary} command' ${words(nodes.map((node) => node.name))}; return; fi`,
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
    `complete -c ${binary} -f -n "__fish_use_subcommand" -a "${words(nodes.map((node) => node.name))}"`
  ];
  for (const node of nodes) {
    if (node.subcommands.length > 0) {
      lines.push(
        `complete -c ${binary} -f -n "__fish_seen_subcommand_from ${node.name}" -a "${words(node.subcommands)}"`
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
