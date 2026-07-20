/**
 * The presenter contract every command renders through. Two
 * implementations exist:
 *
 * - `InkPresenter` — rich Ink (React) rendering on an interactive TTY.
 * - `PlainPresenter` — ordered line logs for CI, pipes, and `ROUTEKIT_NO_TUI`.
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

export type LiveFrameContent = readonly string[] | (() => readonly string[]);

export type LiveFrameController = {
  /** Replace the current frame. Plain output appends a timestamped snapshot. */
  render(content: LiveFrameContent): void;
  /** Render a failed refresh. Quiet presenters may surface only this frame. */
  renderError?(content: LiveFrameContent): void;
  /** Settle the frame and release any terminal resources. Idempotent. */
  stop(): void;
};

/** One row of a `keyValue` block: label, rendered value, optional dim tag. */
export type KeyValueRow = { label: string; value: string; tag?: string; indent?: number };

export type TableOptions = {
  /** Column headers (rendered dim). */
  head?: string[];
  /** Indentation (spaces) applied to every row. */
  indent?: number;
  /** Per-column alignment (numbers read best right-aligned). Defaults to left. */
  align?: readonly ("left" | "right")[];
};

/**
 * One error, three renderings: a red-framed panel on rich/plain UI, prefixed
 * lines when boxes would be noise, and the same fields in `--json` payloads.
 */
export type ErrorPanelInput = {
  /** Panel title (defaults to "error"). */
  title?: string;
  message: string;
  /** Supporting evidence, e.g. a distilled log tail (rendered dim). */
  details?: readonly string[];
  /** A human explanation of what likely went wrong / what to check. */
  hint?: string;
  /** A copy-pasteable next command, rendered as `→ try: <command>`. */
  tryCommand?: string;
  /** A docs URL for the failure area. */
  docs?: string;
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
  /** A red-framed failure panel: message, evidence, hint, and the next command. */
  errorPanel(input: ErrorPanelInput): void;

  /** A live multi-step checklist. */
  checklist(steps: readonly StepInput[], options?: { title?: string }): ChecklistController;
  /** A single live spinner task. */
  task(text: string): TaskController;
  /** A live byte-download progress bar. */
  progress(label: string): ProgressController;
  /** A generic replaceable region for status dashboards and watch commands. */
  liveFrame(): LiveFrameController;
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

export type WatchOptions = {
  signal?: AbortSignal;
  errorFrame?: (error: unknown) => readonly string[];
};

function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function fetchFrame(
  fetchAndRender: (signal: AbortSignal) => Promise<LiveFrameContent> | LiveFrameContent,
  signal: AbortSignal
): Promise<LiveFrameContent | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const succeed = (content: LiveFrameContent | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(content);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => succeed(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (settled || signal.aborted) return undefined;
        return fetchAndRender(signal);
      })
      .then((content) => {
        if (content !== undefined) succeed(content);
      }, fail);
  });
}

/**
 * Poll and redraw a live frame until Ctrl+C or an AbortSignal stops it.
 * Fetch failures become frames and are retried on the next interval.
 */
export async function watch(
  presenter: Presenter,
  intervalSeconds: number,
  fetchAndRender: (signal: AbortSignal) => Promise<LiveFrameContent> | LiveFrameContent,
  options: WatchOptions = {}
): Promise<void> {
  const frame = presenter.liveFrame();
  const localAbort = new AbortController();
  const onSigint = (): void => localAbort.abort();
  const onExternalAbort = (): void => localAbort.abort();
  process.once("SIGINT", onSigint);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted === true) localAbort.abort();
  const milliseconds = Math.max(0.1, intervalSeconds) * 1000;
  try {
    while (!localAbort.signal.aborted) {
      try {
        const content = await fetchFrame(fetchAndRender, localAbort.signal);
        if (content === undefined || localAbort.signal.aborted) break;
        frame.render(content);
      } catch (error) {
        if (localAbort.signal.aborted) break;
        const content = options.errorFrame?.(error) ?? [
          `error: ${error instanceof Error ? error.message : String(error)}`,
          `retrying in ${intervalSeconds}s`
        ];
        if (frame.renderError !== undefined) frame.renderError(content);
        else frame.render(content);
      }
      await waitForInterval(milliseconds, localAbort.signal);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onExternalAbort);
    frame.stop();
  }
}
