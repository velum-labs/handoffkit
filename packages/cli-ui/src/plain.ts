/**
 * The plain-text presenter: ordered, deterministic line logs for CI, pipes,
 * `ROUTEKIT_NO_TUI=1`, and the `node --test` subprocess suites. Live surfaces
 * print one line per state transition instead of animating in place.
 */
import { contentWidth, formatBytes, wrapText } from "./format.js";
import type {
  ChecklistController,
  ErrorPanelInput,
  KeyValueRow,
  LiveFrameContent,
  LiveFrameController,
  Presenter,
  ProgressController,
  ProgressUpdate,
  StatusKind,
  StepInput,
  StepStatus,
  TableOptions,
  TaskController
} from "./presenter.js";
import { uiStream } from "./runtime.js";
import {
  bold,
  box,
  brandBanner,
  brandHeader,
  cyan,
  dim,
  glyph,
  gray,
  green,
  red,
  stripAnsi,
  yellow
} from "./theme.js";

function statusGlyph(kind: StatusKind): string {
  switch (kind) {
    case "ok":
      return green(glyph.tick());
    case "warn":
      return yellow(glyph.warn());
    case "fail":
      return red(glyph.cross());
    case "info":
      return cyan(glyph.bullet());
    case "pending":
      return gray(glyph.bullet());
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown status kind: ${String(exhaustive)}`);
    }
  }
}

function stepGlyph(status: StepStatus): string {
  switch (status) {
    case "pending":
      return gray(glyph.pending());
    case "active":
      return dim(glyph.arrow());
    case "done":
      return green(glyph.tick());
    case "failed":
      return red(glyph.cross());
    case "skipped":
      return yellow(glyph.bullet());
    default: {
      const exhaustive: never = status;
      throw new Error(`unknown step status: ${String(exhaustive)}`);
    }
  }
}

/** Pad table cells against their visible (ANSI-stripped) width. */
function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
  const pad = " ".repeat(Math.max(0, width - stripAnsi(text).length));
  return align === "right" ? pad + text : text + pad;
}

export function renderTableLines(
  rows: readonly (readonly string[])[],
  options: TableOptions = {}
): string[] {
  const all = options.head !== undefined ? [options.head.map((cell) => dim(cell)), ...rows] : [...rows];
  if (all.length === 0) return [];
  const columns = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...all.map((row) => stripAnsi(row[index] ?? "").length))
  );
  const indent = " ".repeat(options.indent ?? 0);
  return all.map((row) =>
    (
      indent +
      row.map((cell, index) => padCell(cell, widths[index] ?? 0, options.align?.[index] ?? "left")).join("  ")
    ).trimEnd()
  );
}

/**
 * Render the failure panel as styled lines: a red-framed box with the message,
 * dim evidence lines, the hint, and a `try:` next command. Shared by the plain
 * and Ink presenters (identical settled output) and reused by the top-level
 * error handler.
 */
export function renderErrorPanelLines(input: ErrorPanelInput): string[] {
  const width = contentWidth();
  const body: string[] = wrapText(input.message, width).map((line) => red(line));
  if (input.details !== undefined && input.details.length > 0) {
    body.push("");
    for (const detail of input.details) {
      for (const line of wrapText(detail, width - 2)) body.push(dim(`  ${line}`));
    }
  }
  if (input.hint !== undefined) {
    body.push("");
    for (const line of wrapText(input.hint, width)) body.push(line);
  }
  if (input.tryCommand !== undefined) {
    body.push("");
    body.push(`${dim("try:")}  ${cyan(input.tryCommand)}`);
  }
  if (input.docs !== undefined) {
    if (input.tryCommand === undefined) body.push("");
    body.push(`${dim("docs:")} ${dim(input.docs)}`);
  }
  return box(input.title ?? "error", body, { tone: "error" }).split("\n");
}

export function renderKeyValueLines(rows: readonly KeyValueRow[]): string[] {
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  const valueWidth = Math.max(0, ...rows.map((row) => stripAnsi(row.value).length));
  return rows.map((row) => {
    const indent = " ".repeat(2 + (row.indent ?? 0) * 2);
    const label = dim(row.label.padEnd(labelWidth));
    const value = row.tag !== undefined ? padCell(row.value, valueWidth) : row.value;
    const tag = row.tag !== undefined ? ` ${dim(row.tag)}` : "";
    return `${indent}${label}  ${value}${tag}`.trimEnd();
  });
}

class PlainChecklist implements ChecklistController {
  private readonly steps: Map<string, { label: string; detail?: string }>;
  private readonly write: (line: string) => void;

  constructor(steps: readonly StepInput[], title: string | undefined, write: (line: string) => void) {
    this.steps = new Map(steps.map((step) => [step.id, { label: step.label }]));
    this.write = write;
    if (title !== undefined) write(title);
  }

  private transition(id: string, status: StepStatus, detail?: string): void {
    const step = this.steps.get(id);
    if (step === undefined) throw new Error(`unknown step id: ${id}`);
    if (detail !== undefined) step.detail = detail;
    const suffix = step.detail !== undefined ? ` ${dim(step.detail)}` : "";
    this.write(`${stepGlyph(status)} ${step.label}${suffix}`);
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
    const step = this.steps.get(id);
    if (step === undefined) throw new Error(`unknown step id: ${id}`);
    step.detail = detail;
  }
  stop(): void {
    // line-per-transition output needs no settling
  }
}

class PlainTask implements TaskController {
  private text: string;
  private readonly write: (line: string) => void;

  constructor(text: string, write: (line: string) => void) {
    this.text = text;
    this.write = write;
    write(`${dim(glyph.arrow())} ${text}`);
  }

  update(text: string): void {
    this.text = text;
    this.write(`${dim(glyph.arrow())} ${text}`);
  }
  succeed(text?: string): void {
    this.write(`${green(glyph.tick())} ${text ?? this.text}`);
  }
  fail(text?: string): void {
    this.write(`${red(glyph.cross())} ${text ?? this.text}`);
  }
  warn(text?: string): void {
    this.write(`${yellow(glyph.warn())} ${text ?? this.text}`);
  }
  info(text?: string): void {
    this.write(`${cyan(glyph.bullet())} ${text ?? this.text}`);
  }
  stop(): void {
    // nothing to settle
  }
}

class PlainProgress implements ProgressController {
  private readonly label: string;
  private readonly write: (line: string) => void;
  private downloaded = 0;
  private total: number | undefined;
  /** Last milestone (in 10% steps) printed, so logs stay short. */
  private lastMilestone = -1;

  constructor(label: string, write: (line: string) => void) {
    this.label = label;
    this.write = write;
    write(`${dim(glyph.arrow())} ${label}`);
  }

  update(progress: ProgressUpdate): void {
    this.downloaded = progress.downloaded;
    if (progress.total !== undefined && progress.total > 0) this.total = progress.total;
    if (this.total === undefined) return;
    const pct = Math.floor((this.downloaded / this.total) * 10) * 10;
    if (pct > this.lastMilestone && pct < 100) {
      this.lastMilestone = pct;
      this.write(`  ${dim(`${pct}% — ${formatBytes(this.downloaded)} / ${formatBytes(this.total)}`)}`);
    }
  }
  succeed(text?: string): void {
    this.write(`${green(glyph.tick())} ${text ?? `${this.label} ${dim(`(${formatBytes(this.downloaded)})`)}`}`);
  }
  fail(text?: string): void {
    this.write(`${red(glyph.cross())} ${text ?? `${this.label} ${gray("(failed)")}`}`);
  }
  stop(): void {
    // nothing to settle
  }
}

class PlainLiveFrame implements LiveFrameController {
  private readonly write: (line: string) => void;
  private stopped = false;

  constructor(write: (line: string) => void) {
    this.write = write;
  }

  render(content: LiveFrameContent): void {
    if (this.stopped) return;
    this.write(dim(`[${new Date().toISOString()}]`));
    for (const line of typeof content === "function" ? content() : content) this.write(line);
  }

  stop(): void {
    this.stopped = true;
  }
}

export class PlainPresenter implements Presenter {
  readonly interactive: boolean = false;
  private readonly stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = uiStream()) {
    this.stream = stream;
  }

  private writeLine = (line: string): void => {
    this.stream.write(`${line}\n`);
  };

  banner(subtitle?: string): void {
    this.writeLine(brandBanner(subtitle));
  }
  header(subtitle?: string): void {
    this.writeLine(brandHeader(subtitle));
  }
  heading(text: string): void {
    this.writeLine(bold(text));
  }
  line(text: string): void {
    this.writeLine(text);
  }
  blank(): void {
    this.stream.write("\n");
  }
  note(text: string): void {
    this.writeLine(`${gray(glyph.arrow())} ${text}`);
  }
  success(text: string): void {
    this.writeLine(`${green(glyph.tick())} ${text}`);
  }
  warn(text: string): void {
    this.writeLine(`${yellow(glyph.warn())} ${text}`);
  }
  error(text: string): void {
    this.writeLine(`${red(glyph.cross())} ${text}`);
  }
  status(kind: StatusKind, label: string, detail?: string, hint?: string): void {
    const suffix = detail !== undefined ? ` ${dim(detail)}` : "";
    this.writeLine(`  ${statusGlyph(kind)} ${label}${suffix}`);
    if (hint !== undefined) this.writeLine(`    ${yellow(glyph.arrow())} ${hint}`);
  }
  keyValue(rows: readonly KeyValueRow[]): void {
    for (const line of renderKeyValueLines(rows)) this.writeLine(line);
  }
  table(rows: readonly (readonly string[])[], options?: TableOptions): void {
    for (const line of renderTableLines(rows, options)) this.writeLine(line);
  }
  box(title: string, lines: readonly string[]): void {
    this.writeLine(box(title, [...lines]));
  }
  errorPanel(input: ErrorPanelInput): void {
    for (const line of renderErrorPanelLines(input)) this.writeLine(line);
  }

  checklist(steps: readonly StepInput[], options: { title?: string } = {}): ChecklistController {
    return new PlainChecklist(steps, options.title, this.writeLine);
  }
  task(text: string): TaskController {
    return new PlainTask(text, this.writeLine);
  }
  progress(label: string): ProgressController {
    return new PlainProgress(label, this.writeLine);
  }
  liveFrame(): LiveFrameController {
    return new PlainLiveFrame(this.writeLine);
  }
}
