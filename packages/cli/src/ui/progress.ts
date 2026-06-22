/**
 * A single-line byte-progress bar for model downloads. On an interactive TTY it
 * renders in place with a filled bar, percent, transferred/total, speed, and
 * ETA; when the total is unknown (e.g. Xet transfers) it shows a spinner with
 * the bytes moved so far. Off a TTY it degrades to a start line plus occasional
 * milestone lines so logs stay readable and ordered. UI goes to stderr.
 */
import { isInteractive, uiStream } from "./runtime.js";
import { SPINNER_FRAMES, cyan, dim, glyph, gray, green, red, supportsColor } from "./theme.js";

const BAR_WIDTH = 24;

/** Human-readable bytes (binary units), e.g. 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 || unit === 0 ? 0 : 1;
  const text = value.toFixed(precision);
  const trimmed = text.endsWith(".0") ? text.slice(0, -2) : text;
  return `${trimmed} ${units[unit]}`;
}

/** mm:ss for a duration in seconds (caps at 99:59 to stay one column-stable). */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const capped = Math.min(seconds, 99 * 60 + 59);
  const mins = Math.floor(capped / 60);
  const secs = Math.floor(capped % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filledChar = supportsColor() ? "\u2588" : "#";
  const emptyChar = supportsColor() ? "\u2591" : "-";
  const filled = Math.round(clamped * BAR_WIDTH);
  return cyan(filledChar.repeat(filled)) + dim(emptyChar.repeat(BAR_WIDTH - filled));
}

export type ProgressUpdate = { downloaded: number; total?: number; file?: string };

export class ProgressBar {
  private readonly stream = uiStream();
  private readonly interactive = isInteractive();
  private label: string;
  private readonly startedAt = Date.now();
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private downloaded = 0;
  private total: number | undefined;
  private active = false;
  /** Last milestone (in 10% steps) printed in non-interactive mode. */
  private lastMilestone = -1;

  constructor(label: string) {
    this.label = label;
  }

  start(): this {
    if (this.active) return this;
    this.active = true;
    if (!this.interactive) {
      this.stream.write(`${dim(glyph.arrow())} ${this.label}\n`);
      return this;
    }
    this.hideCursor();
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 90);
    this.timer.unref();
    return this;
  }

  update(progress: ProgressUpdate): void {
    this.downloaded = progress.downloaded;
    if (progress.total !== undefined && progress.total > 0) this.total = progress.total;
    if (this.interactive) {
      if (this.active) this.render();
    } else {
      this.printMilestone();
    }
  }

  succeed(text?: string): void {
    this.settle(green(glyph.tick()), text ?? `${this.label} ${dim(`(${formatBytes(this.downloaded)})`)}`);
  }

  fail(text?: string): void {
    this.settle(red(glyph.cross()), text ?? `${this.label} ${gray("(failed)")}`);
  }

  stop(): void {
    this.teardown();
  }

  private settle(symbol: string, text: string): void {
    this.teardown();
    this.stream.write(`${symbol} ${text}\n`);
  }

  private speedBytesPerSec(): number {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (elapsed <= 0) return 0;
    return this.downloaded / elapsed;
  }

  private printMilestone(): void {
    if (this.total === undefined) return;
    const pct = Math.floor((this.downloaded / this.total) * 10) * 10;
    if (pct > this.lastMilestone && pct < 100) {
      this.lastMilestone = pct;
      this.stream.write(
        `  ${dim(`${pct}% — ${formatBytes(this.downloaded)} / ${formatBytes(this.total)}`)}\n`
      );
    }
  }

  private render(): void {
    const speed = this.speedBytesPerSec();
    const speedLabel = speed > 0 ? `${formatBytes(speed)}/s` : "";
    let body: string;
    if (this.total !== undefined && this.total > 0) {
      const fraction = this.downloaded / this.total;
      const pct = `${Math.floor(fraction * 100)}%`.padStart(4);
      const sizes = `${formatBytes(this.downloaded)} / ${formatBytes(this.total)}`;
      const remaining = speed > 0 ? formatEta((this.total - this.downloaded) / speed) : "--:--";
      const meta = dim(`${sizes}  ${speedLabel}  eta ${remaining}`);
      body = `${renderBar(fraction)} ${cyan(pct)}  ${meta}`;
    } else {
      const spinner = cyan(SPINNER_FRAMES[this.frame] ?? "-");
      const meta = dim(`${formatBytes(this.downloaded)}${speedLabel.length > 0 ? `  ${speedLabel}` : ""}`);
      body = `${spinner} ${meta}`;
    }
    this.clearLine();
    this.stream.write(`${this.label}  ${body}`);
  }

  private teardown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.active && this.interactive) {
      this.clearLine();
      this.showCursor();
    }
    this.active = false;
  }

  private clearLine(): void {
    if (this.interactive) this.stream.write("\r\u001b[2K");
  }

  private hideCursor(): void {
    if (this.interactive) this.stream.write("\u001b[?25l");
  }

  private showCursor(): void {
    if (this.interactive) this.stream.write("\u001b[?25h");
  }
}
