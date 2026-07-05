/**
 * The bare-invocation command palette: `fusionkit` with no arguments on an
 * interactive TTY opens a fuzzy-searchable list of actions, each showing the
 * equivalent command — usable with zero prior knowledge of the CLI, and
 * teaching it at the same time. Off-TTY (pipes, CI) bare invocation keeps
 * printing help, so scripts and captures never block on a prompt.
 */
import { brandBanner, canPromptInteractively, fuzzySelect, isInteractive, uiStream } from "@fusionkit/cli-ui";

type PaletteAction = {
  label: string;
  hint: string;
  argv: readonly string[] | undefined;
};

const ACTIONS: readonly PaletteAction[] = [
  { label: "Run codex with fusion", hint: "fusionkit codex", argv: ["codex"] },
  { label: "Run claude with fusion", hint: "fusionkit claude", argv: ["claude"] },
  { label: "Run cursor with fusion", hint: "fusionkit cursor", argv: ["cursor"] },
  { label: "Run the gateway for any tool", hint: "fusionkit serve", argv: ["serve"] },
  { label: "Set up this repo (.fusionkit/)", hint: "fusionkit init", argv: ["init"] },
  { label: "Check my environment", hint: "fusionkit doctor", argv: ["doctor"] },
  { label: "Warm the fusion engine", hint: "fusionkit setup", argv: ["setup"] },
  { label: "Show the effective config", hint: "fusionkit status", argv: ["status"] },
  { label: "Edit the repo config", hint: "fusionkit config edit", argv: ["config", "edit"] },
  { label: "Browse stored sessions", hint: "fusionkit sessions", argv: ["sessions"] },
  { label: "Manage named ensembles", hint: "fusionkit ensemble list", argv: ["ensemble", "list"] },
  { label: "Manage local MLX models", hint: "fusionkit models", argv: ["models"] },
  { label: "Stop background fusion services", hint: "fusionkit fusion stop", argv: ["fusion", "stop"] },
  { label: "Show versions", hint: "fusionkit version", argv: ["version"] },
  { label: "Show help", hint: "fusionkit --help", argv: undefined }
];

/**
 * Run the palette and return the argv to execute (relative to the program),
 * or undefined when help should print instead (off-TTY, or "Show help").
 */
export async function runCommandPalette(): Promise<string[] | undefined> {
  if (!canPromptInteractively() || !isInteractive()) return undefined;
  uiStream().write(`${brandBanner()}\n\n`);
  const argv = await fuzzySelect<readonly string[] | undefined>({
    message: "What would you like to do?",
    placeholder: "type to search",
    options: ACTIONS.map((action) => ({ value: action.argv, label: action.label, hint: action.hint }))
  });
  return argv === undefined ? undefined : [...argv];
}
