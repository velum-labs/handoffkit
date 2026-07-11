/**
 * Per-invocation command context: the presenter every command renders through,
 * the machine-output (`--json`) emitter, and the resolved global flags.
 *
 * Global flags (they must precede the subcommand name, like every fusionkit
 * flag):
 *
 *   --json      emit a machine-readable JSON result on stdout (implies
 *               non-interactive; all human UI is suppressed)
 *   --no-input  never prompt; prompts resolve to their defaults (CI posture)
 *   --yes       accept confirmations (cost consent, overwrites) without asking
 *   --quiet     suppress informational output; warnings and errors still print
 *
 * The presenter renders to stderr; `emit` writes to stdout — so `--json`
 * output stays pipe-clean even when warnings appear.
 */
import type { Command } from "commander";

import { createPresenter, forceNonInteractive, PlainPresenter } from "@fusionkit/cli-ui";
import type {
  ChecklistController,
  KeyValueRow,
  Presenter,
  ProgressController,
  StatusKind,
  StepInput,
  TableOptions,
  TaskController
} from "@fusionkit/cli-ui";

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  quiet: boolean;
  noInput: boolean;
};

export type CommandContext = GlobalFlags & {
  presenter: Presenter;
  /** Write the command's machine-readable result to stdout (used with --json). */
  emit(payload: unknown): void;
};

/** Set when any command runs in --json mode, so the top-level error handler
 * can emit a structured error instead of styled text. */
let jsonMode = false;

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Emit a machine-readable result on stdout. */
export function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

/**
 * A presenter that drops informational output but keeps warnings and errors
 * (the `--quiet` posture, and the UI channel under `--json`).
 */
class QuietPresenter extends PlainPresenter {
  override banner(): void {}
  override header(): void {}
  override heading(): void {}
  override line(): void {}
  override blank(): void {}
  override note(): void {}
  override success(): void {}
  override status(kind: StatusKind, label: string, detail?: string, hint?: string): void {
    if (kind === "fail" || kind === "warn") super.status(kind, label, detail, hint);
  }
  override keyValue(_rows: readonly KeyValueRow[]): void {}
  override table(_rows: readonly (readonly string[])[], _options?: TableOptions): void {}
  override box(_title: string, _lines: readonly string[]): void {}
  override checklist(steps: readonly StepInput[]): ChecklistController {
    const labels = new Map(steps.map((step) => [step.id, step.label]));
    const failed = (id: string, detail?: string): void => {
      this.error(`${labels.get(id) ?? id}${detail !== undefined ? ` ${detail}` : ""}`);
    };
    return {
      setActive: () => {},
      setDone: () => {},
      setFailed: failed,
      setSkipped: () => {},
      setDetail: () => {},
      stop: () => {}
    };
  }
  override task(text: string): TaskController {
    return {
      update: () => {},
      succeed: () => {},
      fail: (line) => this.error(line ?? text),
      warn: (line) => this.warn(line ?? text),
      info: () => {},
      stop: () => {}
    };
  }
  override progress(label: string): ProgressController {
    return {
      update: () => {},
      succeed: () => {},
      fail: (line) => this.error(line ?? label),
      stop: () => {}
    };
  }
}

type RawGlobalOpts = { json?: boolean; yes?: boolean; quiet?: boolean; input?: boolean };

/**
 * Build the context for one command invocation. `command` is the commander
 * instance passed as the last action argument; global flags are merged from
 * the program level via `optsWithGlobals`.
 */
export function contextFor(command: Command): CommandContext {
  const opts = command.optsWithGlobals<RawGlobalOpts>();
  const json = opts.json === true;
  const quiet = opts.quiet === true;
  const noInput = opts.input === false;
  if (json) jsonMode = true;
  if (json || noInput) forceNonInteractive();

  const presenter = json || quiet ? new QuietPresenter() : createPresenter();
  return {
    json,
    yes: opts.yes === true,
    quiet,
    noInput,
    presenter,
    emit: emitJson
  };
}

/** Attach the global flags to the program (they precede the subcommand name). */
export function attachGlobalFlags(program: Command): Command {
  return program
    .option("--json", "emit a machine-readable JSON result on stdout (implies non-interactive)")
    .option("--no-input", "never prompt; prompts resolve to their defaults")
    .option("--yes", "accept confirmations without asking")
    .option("--quiet", "suppress informational output (warnings and errors still print)");
}
