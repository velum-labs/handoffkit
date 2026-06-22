/**
 * Help text for `fusionkit fusion claude --help` / forwarded `--help` on the
 * claude launcher (before preflight or spawning Claude).
 */

/** True when forwarded tool args request help. */
export function isForwardedToolHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Print the fusionkit routing wrapper help for Claude Code.
 */
export function printClaudeRouteHelp(): void {
  const lines = [
    "fusionkit claude — Claude Code with optional smart routing",
    "",
    "Smart routing flags (fusionkit; must precede claude args):",
    "  --route                 enable scenario-based model selection",
    "  --route-dry-run         print the routing decision and exit",
    "  --route-preview <text>  sample prompt for --route-dry-run",
    "  --repo <dir>            coding workspace for routing config lookup",
    "",
    "Other fusionkit flags (--model, --local, --observe, ...) also apply; see",
    "  fusionkit claude -h",
    "",
    "This help describes the fusionkit routing wrapper. Run claude --help from a",
    "real Claude Code install for Claude's own CLI help."
  ];
  console.log(lines.join("\n"));
}
