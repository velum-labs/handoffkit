/**
 * The Ink presenter: rich rendering for interactive TTYs. Static output is
 * written as styled lines (identical to the plain presenter, so transcripts
 * stay consistent); live surfaces — checklist, task, progress — mount a
 * bounded Ink app each, and settle by clearing the live region, unmounting,
 * and writing the final state as ordinary lines. Nothing stays mounted after
 * a surface settles, so the terminal can always be handed to a spawned coding
 * agent cleanly.
 */
import { render } from "ink";
import type { Instance } from "ink";
import { createElement, Fragment } from "react";
import type { ReactElement } from "react";

import { formatBytes } from "../format.js";
import { PlainPresenter } from "../plain.js";
import type {
  ChecklistController,
  LiveFrameContent,
  LiveFrameController,
  ProgressController,
  ProgressUpdate,
  StepInput,
  StepStatus,
  TaskController
} from "../presenter.js";
import { uiStream } from "../runtime.js";
import { cyan, dim, glyph, gray, green, red, yellow } from "../theme.js";

import { ChecklistView, LiveFrameView, ProgressView, TaskView } from "./components.js";
import type {
  ChecklistState,
  ChecklistStep,
  LiveFrameState,
  ProgressState,
  TaskState
} from "./components.js";
import { Store } from "./store.js";

/** Mount a bounded Ink app on stderr (stdout stays reserved for payloads). */
export function mountInk(node: ReactElement): Instance {
  return render(node, {
    stdout: uiStream(),
    stderr: uiStream(),
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false
  });
}

/**
 * Clear the live Ink region and unmount, leaving the terminal clean for the
 * caller to write the settled plain lines.
 *
 * Ink throttles renders (~30fps) with a trailing call, so `instance.clear()`
 * followed by `unmount()` is racy: unmount flushes the pending trailing
 * render *after* the clear, repainting the live frame — which the caller's
 * raw write then duplicates on screen. Rerendering an empty node first makes
 * that flushed render paint emptiness (erasing the region), so nothing stale
 * survives the unmount.
 */
export function settleInk(instance: Instance): void {
  instance.rerender(createElement(Fragment));
  instance.unmount();
  instance.cleanup();
}

function stepFinalLine(step: ChecklistStep): string {
  let symbol: string;
  switch (step.status) {
    case "pending":
      symbol = gray(glyph.pending());
      break;
    case "active":
      symbol = dim(glyph.arrow());
      break;
    case "done":
      symbol = green(glyph.tick());
      break;
    case "failed":
      symbol = red(glyph.cross());
      break;
    case "skipped":
      symbol = yellow(glyph.bullet());
      break;
    default: {
      const exhaustive: never = step.status;
      throw new Error(`unknown step status: ${String(exhaustive)}`);
    }
  }
  const detail = step.detail !== undefined ? ` ${dim(step.detail)}` : "";
  const elapsed =
    step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt - step.startedAt >= 50
      ? gray(` ${((step.endedAt - step.startedAt) / 1000).toFixed(1)}s`)
      : "";
  return `${symbol} ${step.label}${detail}${elapsed}`;
}

class InkChecklist implements ChecklistController {
  private readonly store: Store<ChecklistState>;
  private readonly instance: Instance;
  private readonly stream = uiStream();
  private settled = false;

  constructor(steps: readonly StepInput[], title: string | undefined) {
    this.store = new Store<ChecklistState>({
      ...(title !== undefined ? { title } : {}),
      steps: steps.map((step) => ({ id: step.id, label: step.label, status: "pending" as StepStatus }))
    });
    this.instance = mountInk(<ChecklistView store={this.store} />);
  }

  private transition(id: string, status: StepStatus, detail?: string): void {
    this.store.set((state) => ({
      ...state,
      steps: state.steps.map((step) => {
        if (step.id !== id) return step;
        const now = Date.now();
        const startedAt = step.startedAt ?? (status !== "pending" ? now : undefined);
        const endedAt =
          status === "done" || status === "failed" || status === "skipped"
            ? (step.endedAt ?? now)
            : step.endedAt;
        return {
          ...step,
          status,
          ...(detail !== undefined ? { detail } : {}),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {})
        };
      })
    }));
  }

  setActive(id: string, detail?: string): void {
    this.transition(id, "active", detail);
  }
  setDone(id: string, detail?: string): void {
    this.transition(id, "done", detail);
  }
  setFailed(id: string, detail?: string): void {
    this.transition(id, "failed", detail);
  }
  setSkipped(id: string, detail?: string): void {
    this.transition(id, "skipped", detail);
  }
  setDetail(id: string, detail: string): void {
    this.store.set((state) => ({
      ...state,
      steps: state.steps.map((step) => (step.id === id ? { ...step, detail } : step))
    }));
  }

  stop(): void {
    if (this.settled) return;
    this.settled = true;
    settleInk(this.instance);
    const state = this.store.get();
    const lines: string[] = [];
    if (state.title !== undefined) lines.push(state.title);
    for (const step of state.steps) lines.push(stepFinalLine(step));
    this.stream.write(lines.join("\n") + "\n");
  }
}

class InkTask implements TaskController {
  private readonly store: Store<TaskState>;
  private readonly instance: Instance;
  private readonly stream = uiStream();
  private settled = false;

  constructor(text: string) {
    this.store = new Store<TaskState>({ text });
    this.instance = mountInk(<TaskView store={this.store} />);
  }

  update(text: string): void {
    this.store.set((state) => ({ ...state, text }));
  }

  private settle(line: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    settleInk(this.instance);
    if (line !== undefined) this.stream.write(`${line}\n`);
  }

  succeed(text?: string): void {
    this.settle(`${green(glyph.tick())} ${text ?? this.store.get().text}`);
  }
  fail(text?: string): void {
    this.settle(`${red(glyph.cross())} ${text ?? this.store.get().text}`);
  }
  warn(text?: string): void {
    this.settle(`${yellow(glyph.warn())} ${text ?? this.store.get().text}`);
  }
  info(text?: string): void {
    this.settle(`${cyan(glyph.bullet())} ${text ?? this.store.get().text}`);
  }
  stop(): void {
    this.settle(undefined);
  }
}

class InkProgress implements ProgressController {
  private readonly store: Store<ProgressState>;
  private readonly instance: Instance;
  private readonly stream = uiStream();
  private settled = false;

  constructor(label: string) {
    this.store = new Store<ProgressState>({ label, downloaded: 0, startedAt: Date.now() });
    this.instance = mountInk(<ProgressView store={this.store} />);
  }

  update(progress: ProgressUpdate): void {
    this.store.set((state) => ({
      ...state,
      downloaded: progress.downloaded,
      ...(progress.total !== undefined && progress.total > 0 ? { total: progress.total } : {})
    }));
  }

  private settle(line: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    settleInk(this.instance);
    if (line !== undefined) this.stream.write(`${line}\n`);
  }

  succeed(text?: string): void {
    const state = this.store.get();
    this.settle(
      `${green(glyph.tick())} ${text ?? `${state.label} ${dim(`(${formatBytes(state.downloaded)})`)}`}`
    );
  }
  fail(text?: string): void {
    const state = this.store.get();
    this.settle(`${red(glyph.cross())} ${text ?? `${state.label} ${gray("(failed)")}`}`);
  }
  stop(): void {
    this.settle(undefined);
  }
}

class InkLiveFrame implements LiveFrameController {
  private readonly store = new Store<LiveFrameState>({ lines: [] });
  private readonly instance = mountInk(<LiveFrameView store={this.store} />);
  private readonly stream = uiStream();
  private settled = false;

  render(content: LiveFrameContent): void {
    if (this.settled) return;
    const lines = [...(typeof content === "function" ? content() : content)];
    this.store.set(() => ({ lines }));
  }

  stop(): void {
    if (this.settled) return;
    this.settled = true;
    settleInk(this.instance);
    const lines = this.store.get().lines;
    if (lines.length > 0) this.stream.write(`${lines.join("\n")}\n`);
  }
}

/**
 * Rich presenter. Extends the plain presenter for static output (identical
 * line rendering) and swaps the live surfaces for Ink-mounted components.
 */
export class InkPresenter extends PlainPresenter {
  override readonly interactive: boolean = true;

  override checklist(steps: readonly StepInput[], options: { title?: string } = {}): ChecklistController {
    return new InkChecklist(steps, options.title);
  }
  override task(text: string): TaskController {
    return new InkTask(text);
  }
  override progress(label: string): ProgressController {
    return new InkProgress(label);
  }
  override liveFrame(): LiveFrameController {
    return new InkLiveFrame();
  }
}
