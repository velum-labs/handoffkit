import { isInteractive, uiStream } from "./runtime.js";
import { SPINNER_FRAMES, cyan, dim, glyph, gray, green, red, yellow } from "./theme.js";

/**
 * A single-line spinner. On an interactive TTY it animates in place; otherwise
 * it prints one line per state transition so logs stay readable and ordered.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text: string;
  private readonly stream = uiStream();
  private readonly interactive = isInteractive();
  private active = false;

  constructor(text: string) {
    this.text = text;
  }

  start(): this {
    if (this.active) return this;
    this.active = true;
    if (!this.interactive) {
      this.stream.write(`${dim(glyph.arrow())} ${this.text}\n`);
      return this;
    }
    this.hideCursor();
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
    this.timer.unref();
    return this;
  }

  update(text: string): this {
    this.text = text;
    if (this.active && this.interactive) this.render();
    else if (this.active) this.stream.write(`${dim(glyph.arrow())} ${this.text}\n`);
    return this;
  }

  succeed(text?: string): void {
    this.settle(green(glyph.tick()), text ?? this.text);
  }

  fail(text?: string): void {
    this.settle(red(glyph.cross()), text ?? this.text);
  }

  warn(text?: string): void {
    this.settle(yellow(glyph.warn()), text ?? this.text);
  }

  info(text?: string): void {
    this.settle(cyan(glyph.bullet()), text ?? this.text);
  }

  stop(): void {
    this.teardown();
  }

  private settle(symbol: string, text: string): void {
    this.teardown();
    this.stream.write(`${symbol} ${text}\n`);
  }

  private render(): void {
    const symbol = cyan(SPINNER_FRAMES[this.frame] ?? "-");
    this.clearLine();
    this.stream.write(`${symbol} ${this.text}`);
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

/** Run `work` under a spinner, settling to success/failure automatically. */
export async function withSpinner<T>(
  text: string,
  work: () => Promise<T>,
  options: { success?: (value: T) => string; failure?: (error: unknown) => string } = {}
): Promise<T> {
  const spinner = new Spinner(text).start();
  try {
    const value = await work();
    spinner.succeed(options.success ? options.success(value) : text);
    return value;
  } catch (error) {
    spinner.fail(options.failure ? options.failure(error) : `${text} ${gray("(failed)")}`);
    throw error;
  }
}
