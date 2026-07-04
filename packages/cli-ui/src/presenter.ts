/**
 * The presenter contract every fusionkit command renders through. Two
 * implementations exist:
 *
 * - `InkPresenter` — rich Ink (React) rendering on an interactive TTY.
 * - `PlainPresenter` — ordered line logs for CI, pipes, and `FUSIONKIT_NO_TUI`.
 *
 * Both write exclusively to stderr (`uiStream()`); stdout stays reserved for
 * machine payloads (`--json`, `config path`, `export-yaml`) and tool output.
 * Live surfaces (checklist / task / progress) return controllers; a command
 * must settle a live surface before printing static lines so output never
 * interleaves with an active Ink render.
 */

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type StepInput = { id: string; label: string };

export type ChecklistController = {
  setActive(id: string, detail?: string): void;
  setDone(id: string, detail?: string): void;
  setFailed(id: string, detail?: string): void;
  setSkipped(id: string, detail?: string): void;
  setDetail(id: string, detail: string): void;
  /** Settle the checklist and leave the final frame in place. */
  stop(): void;
};

export type TaskController = {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
};

export type ProgressUpdate = { downloaded: number; total?: number; file?: string };

export type ProgressController = {
  update(progress: ProgressUpdate): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
};

/** One row of a `keyValue` block: label, rendered value, optional dim tag. */
export type KeyValueRow = { label: string; value: string; tag?: string; indent?: number };

export type TableOptions = {
  /** Column headers (rendered dim). */
  head?: string[];
  /** Indentation (spaces) applied to every row. */
  indent?: number;
};

export type StatusKind = "ok" | "warn" | "fail" | "info" | "pending";

export interface Presenter {
  /** True when this presenter renders rich (Ink) output. */
  readonly interactive: boolean;

  /** The full-dress brand banner (degrades to a one-line header when plain). */
  banner(subtitle?: string): void;
  /** The compact one-line brand header. */
  header(subtitle?: string): void;
  /** A bold section heading. */
  heading(text: string): void;
  /** A raw styled line. */
  line(text: string): void;
  /** An empty spacer line. */
  blank(): void;
  /** A dim informational note (arrow-prefixed). */
  note(text: string): void;
  /** A green tick line. */
  success(text: string): void;
  /** A yellow warning line. */
  warn(text: string): void;
  /** A red error line. */
  error(text: string): void;
  /** A status row: glyph + label + optional dim detail + optional hint line. */
  status(kind: StatusKind, label: string, detail?: string, hint?: string): void;
  /** Aligned label/value rows with optional provenance tags. */
  keyValue(rows: readonly KeyValueRow[]): void;
  /** A simple aligned table. */
  table(rows: readonly (readonly string[])[], options?: TableOptions): void;
  /** A titled rounded box. */
  box(title: string, lines: readonly string[]): void;

  /** A live multi-step checklist. */
  checklist(steps: readonly StepInput[], options?: { title?: string }): ChecklistController;
  /** A single live spinner task. */
  task(text: string): TaskController;
  /** A live byte-download progress bar. */
  progress(label: string): ProgressController;
}

/** Run `work` under a task spinner, settling to success/failure automatically. */
export async function withTask<T>(
  presenter: Presenter,
  text: string,
  work: () => Promise<T>,
  options: { success?: (value: T) => string; failure?: (error: unknown) => string } = {}
): Promise<T> {
  const task = presenter.task(text);
  try {
    const value = await work();
    task.succeed(options.success ? options.success(value) : text);
    return value;
  } catch (error) {
    task.fail(options.failure ? options.failure(error) : `${text} (failed)`);
    throw error;
  }
}
