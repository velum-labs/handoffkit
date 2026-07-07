import type { Command } from "commander";

const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

type CompletionShell = (typeof COMPLETION_SHELLS)[number];

type CommandNode = {
  name: string;
  subcommands: string[];
};

function isCompletionShell(value: string): value is CompletionShell {
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

function words(values: readonly string[]): string {
  return values.join(" ");
}

function bashCompletion(nodes: readonly CommandNode[]): string {
  const topLevel = words(nodes.map((node) => node.name));
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map(
      (node) =>
        `    ${node.name}) COMPREPLY=( $(compgen -W "${words(node.subcommands)}" -- "$cur") ); return ;;`
    )
    .join("\n");
  return [
    "# bash completion for fusionkit",
    "# Dynamic candidates come from `fusionkit __complete` (live session ids,",
    "# ensemble names, config paths, local models); the static tree below is the",
    "# fallback when that call fails or returns nothing.",
    "_fusionkit_completion() {",
    "  local cur dynamic",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  dynamic=\"$(fusionkit __complete -- \"${COMP_WORDS[@]:1:COMP_CWORD}\" 2>/dev/null)\"",
    "  if [[ -n \"${dynamic}\" ]]; then",
    "    COMPREPLY=( $(compgen -W \"${dynamic}\" -- \"$cur\") )",
    "    return",
    "  fi",
    "  if [[ ${COMP_CWORD} -eq 1 ]]; then",
    `    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )`,
    "    return",
    "  fi",
    "  case \"${COMP_WORDS[1]}\" in",
    cases,
    "  esac",
    "}",
    "complete -F _fusionkit_completion fusionkit",
    ""
  ].join("\n");
}

function zshCompletion(nodes: readonly CommandNode[]): string {
  const topLevel = nodes.map((node) => node.name).join(" ");
  const cases = nodes
    .filter((node) => node.subcommands.length > 0)
    .map((node) => `    ${node.name}) _values '${node.name} command' ${words(node.subcommands)} ;;`)
    .join("\n");
  return [
    "#compdef fusionkit",
    "# zsh completion for fusionkit",
    "# Dynamic candidates come from `fusionkit __complete`; the static tree below",
    "# is the fallback when that call fails or returns nothing.",
    "_fusionkit() {",
    "  local -a dynamic",
    "  dynamic=(${(f)\"$(fusionkit __complete -- ${words[@]:1:$((CURRENT-1))} 2>/dev/null)\"})",
    "  if (( ${#dynamic} )); then",
    "    compadd -- \"${dynamic[@]}\"",
    "    return",
    "  fi",
    "  if (( CURRENT == 2 )); then",
    `    _values 'fusionkit command' ${topLevel}`,
    "    return",
    "  fi",
    "  case \"$words[2]\" in",
    cases,
    "  esac",
    "}",
    "_fusionkit \"$@\"",
    ""
  ].join("\n");
}

function fishCompletion(nodes: readonly CommandNode[]): string {
  const lines = [
    "# fish completion for fusionkit",
    "# Dynamic candidates come from `fusionkit __complete`; fish deduplicates",
    "# them against the static tree below, which stays as the fallback.",
    "function __fusionkit_complete",
    "    set -l tokens (commandline -opc) (commandline -ct)",
    "    fusionkit __complete -- $tokens[2..-1] 2>/dev/null",
    "end",
    'complete -c fusionkit -f -a "(__fusionkit_complete)"',
    `complete -c fusionkit -f -n "__fish_use_subcommand" -a "${words(nodes.map((node) => node.name))}"`
  ];
  for (const node of nodes) {
    if (node.subcommands.length === 0) continue;
    lines.push(
      `complete -c fusionkit -f -n "__fish_seen_subcommand_from ${node.name}" -a "${words(node.subcommands)}"`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function completionScript(shell: CompletionShell, program: Command): string {
  const nodes = commandNodes(program);
  switch (shell) {
    case "bash":
      return bashCompletion(nodes);
    case "zsh":
      return zshCompletion(nodes);
    case "fish":
      return fishCompletion(nodes);
    default: {
      const exhaustive: never = shell;
      throw new Error(`unsupported shell ${String(exhaustive)}`);
    }
  }
}

export function registerCompletion(program: Command): void {
  program
    .command("completion")
    .description("advanced: print a shell completion script")
    .argument("<shell>", COMPLETION_SHELLS.join(" | "))
    .action((shell: string) => {
      if (!isCompletionShell(shell)) {
        throw new Error(`unsupported shell "${shell}" (expected ${COMPLETION_SHELLS.join(" | ")})`);
      }
      process.stdout.write(completionScript(shell, program));
    });
}
