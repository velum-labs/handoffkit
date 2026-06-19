import { isInteractive, uiStream } from "./runtime.js";
import { SPINNER_FRAMES, cyan, dim, glyph, gray, green, red, yellow } from "./theme.js";

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type StepInput = { id: string; label: string };

type Step = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
};

function elapsedLabel(step: Step): string {
  if (step.startedAt === undefined) return "";
  const end = step.endedAt ?? Date.now();
  const seconds = (end - step.startedAt) / 1000;
  if (seconds < 0.05) return "";
  return gray(` ${seconds.toFixed(1)}s`);
}

function symbolFor(step: Step, frame: number): string {
  switch (step.status) {
    case "pending":
      return gray(glyph.pending());
    case "active":
      return cyan(SPINNER_FRAMES[frame] ?? "-");
    case "done":
      return green(glyph.tick());
    case "failed":
      return red(glyph.cross());
    case "skipped":
      return yellow(glyph.bullet());
    default: {
      const exhaustive: never = step.status;
      throw new Error(`unknown step status: ${String(exhaustive)}`);
    }
  }
}

/**
 * A live checklist of stages. On a TTY it re-renders in place with per-stage
 * spinners and elapsed time; otherwise it prints one line per state transition
 * so non-interactive logs stay ordered and readable.
 */
export class StepList {
  private readonly steps: Step[];
  private readonly stream = uiStream();
  private readonly interactive = isInteractive();
  private readonly title: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private renderedLines = 0;
  private started = false;

  constructor(steps: readonly StepInput[], options: { title?: string } = {}) {
    this.steps = steps.map((step) => ({ id: step.id, label: step.label, status: "pending" }));
    this.title = options.title;
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    if (this.interactive) {
      this.hideCursor();
      this.render();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.render();
      }, 80);
      this.timer.unref();
    } else if (this.title !== undefined) {
      this.stream.write(`${this.title}\n`);
    }
    return this;
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
    const step = this.find(id);
    step.detail = detail;
    if (this.interactive) this.render();
  }

  /** Stop animation and leave the final frame in place. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.interactive && this.started) {
      this.render();
      this.showCursor();
    }
    this.started = false;
  }

  private transition(id: string, status: StepStatus, detail?: string): void {
    const step = this.find(id);
    if (status === "active" && step.startedAt === undefined) step.startedAt = Date.now();
    if ((status === "done" || status === "failed" || status === "skipped") && step.endedAt === undefined) {
      step.endedAt = Date.now();
      if (step.startedAt === undefined) step.startedAt = step.endedAt;
    }
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    if (this.interactive) this.render();
    else this.printLine(step);
  }

  private printLine(step: Step): void {
    const detail = step.detail !== undefined ? ` ${dim(step.detail)}` : "";
    this.stream.write(`${symbolFor(step, 0)} ${step.label}${detail}\n`);
  }

  private render(): void {
    const lines: string[] = [];
    if (this.title !== undefined) lines.push(this.title);
    for (const step of this.steps) {
      const detail = step.detail !== undefined ? ` ${dim(step.detail)}` : "";
      lines.push(`${symbolFor(step, this.frame)} ${step.label}${detail}${elapsedLabel(step)}`);
    }
    this.clear();
    this.stream.write(lines.join("\n") + "\n");
    this.renderedLines = lines.length;
  }

  private clear(): void {
    if (!this.interactive || this.renderedLines === 0) return;
    this.stream.write(`\u001b[${this.renderedLines}A`);
    this.stream.write("\u001b[0J");
  }

  private find(id: string): Step {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (step === undefined) throw new Error(`unknown step id: ${id}`);
    return step;
  }

  private hideCursor(): void {
    if (this.interactive) this.stream.write("\u001b[?25l");
  }

  private showCursor(): void {
    if (this.interactive) this.stream.write("\u001b[?25h");
  }
}
