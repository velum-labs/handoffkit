/**
 * The bare-invocation command palette: `fusionkit` with no arguments on an
 * interactive TTY opens a fuzzy-searchable list of actions, each showing the
 * equivalent command — usable with zero prior knowledge of the CLI, and
 * teaching it at the same time. Off-TTY (pipes, CI) bare invocation keeps
 * printing help, so scripts and captures never block on a prompt.
 *
 * Actions are not hardcoded here: each command module registers its own
 * palette entries next to its Commander registration (via
 * {@link registerPaletteAction}), so the palette can never drift from the
 * commands that actually exist. Palette order follows the registration order
 * in `cli.ts`.
 */
import { brandBanner, canPromptInteractively, fuzzySelect, isInteractive, uiStream } from "@routekit/cli-ui";

import { loadFusionConfig } from "../fusion-config.js";
import { gitToplevel } from "../fusion-quickstart.js";

export type PaletteAction = {
  /** The human phrasing of the action, e.g. "Check my environment". */
  label: string;
  /** The equivalent command, e.g. "fusionkit doctor" (shown dim, also searched). */
  hint: string;
  /** The argv to dispatch (relative to the program); undefined = print help. */
  argv: readonly string[] | undefined;
};

// Keyed by hint so a re-built program (tests build the tree repeatedly in one
// process) re-registers idempotently instead of duplicating entries.
const registry = new Map<string, PaletteAction>();

/** Register palette entries; called by command modules during registration. */
export function registerPaletteAction(...actions: readonly PaletteAction[]): void {
  for (const action of actions) registry.set(action.hint, action);
}

/** Every registered action, in registration order, plus the help escape hatch. */
export function paletteActions(): PaletteAction[] {
  return [...registry.values(), { label: "Show help", hint: "fusionkit --help", argv: undefined }];
}

export function configuredDefaultToolArgv(
  cwd: string = process.cwd()
): string[] | undefined {
  const root = gitToplevel(cwd);
  if (root === undefined) return undefined;
  const tool = loadFusionConfig(root)?.tool;
  return tool === undefined ? undefined : [tool];
}

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
    options: paletteActions().map((action) => ({ value: action.argv, label: action.label, hint: action.hint }))
  });
  return argv === undefined ? undefined : [...argv];
}
