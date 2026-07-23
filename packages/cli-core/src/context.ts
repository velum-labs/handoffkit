import type { Command } from "commander";

import {
  createPresenter,
  forceNonInteractive,
  PlainPresenter,
  stripAnsi
} from "@velum-labs/routekit-cli-ui";
import type {
  ChecklistController,
  KeyValueRow,
  LiveFrameController,
  Presenter,
  ProgressController,
  StatusKind,
  StepInput,
  TableOptions,
  TaskController
} from "@velum-labs/routekit-cli-ui";

export type GlobalFlags = {
  json: boolean;
  yes: boolean;
  quiet: boolean;
  noInput: boolean;
};

export type CommandContext = GlobalFlags & {
  presenter: Presenter;
  emit(payload: unknown): void;
};

let jsonMode = false;

export function isJsonMode(): boolean {
  return jsonMode;
}

export function resetContextForTest(): void {
  jsonMode = false;
}

export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

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
    return {
      setActive: () => {},
      setDone: () => {},
      setFailed: (id, detail) =>
        this.error(`${labels.get(id) ?? id}${detail !== undefined ? ` ${detail}` : ""}`),
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
  override liveFrame(): LiveFrameController {
    return {
      render: () => {},
      renderError: (content) => {
        const lines = typeof content === "function" ? content() : content;
        this.error(lines.map((line) => stripAnsi(line)).join("\n"));
      },
      stop: () => {}
    };
  }
}

type RawGlobalOpts = { json?: boolean; yes?: boolean; quiet?: boolean; input?: boolean };

export function contextFor(command: Command): CommandContext {
  const opts = command.optsWithGlobals<RawGlobalOpts>();
  const json = opts.json === true;
  const quiet = opts.quiet === true;
  const noInput = opts.input === false;
  if (json) jsonMode = true;
  if (json || noInput) forceNonInteractive();
  return {
    json,
    yes: opts.yes === true,
    quiet,
    noInput,
    presenter: json || quiet ? new QuietPresenter() : createPresenter(),
    emit: emitJson
  };
}

export function attachGlobalFlags(program: Command): Command {
  return program
    .option("--json", "emit a machine-readable JSON result on stdout (implies non-interactive)")
    .option("--no-input", "never prompt; prompts resolve to their defaults")
    .option("--yes", "accept confirmations without asking")
    .option("--quiet", "suppress informational output (warnings and errors still print)");
}
