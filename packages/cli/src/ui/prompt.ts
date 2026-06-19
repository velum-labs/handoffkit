import { createInterface, emitKeypressEvents } from "node:readline";

import { canPromptInteractively, uiStream } from "./runtime.js";
import { bold, cyan, dim, glyph, gray, green } from "./theme.js";

export type SelectOption<T> = { value: T; label: string; hint?: string };

const out = uiStream();

// For non-interactive input (piped/redirected/empty stdin) we read all of stdin
// exactly once and serve answers line by line. This supports scripted input
// (`printf "2\n3\n" | fusionkit fusion init`) and falls back to "" (the prompt
// default) once exhausted — without the fragile behavior of attaching multiple
// readline interfaces to an already-ended stdin.
let bufferedLines: string[] | undefined;
let bufferedRead = false;

async function ensureBufferedStdin(): Promise<void> {
  if (bufferedRead) return;
  bufferedRead = true;
  if (process.stdin.isTTY || process.stdin.readableEnded) {
    bufferedLines = [];
    return;
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => resolve());
    process.stdin.once("error", () => resolve());
  });
  bufferedLines = Buffer.concat(chunks).toString("utf8").split("\n");
}

/**
 * Read a single line from stdin, prompting on stderr. On a TTY this reads live;
 * otherwise it draws from buffered stdin and resolves to "" when there is no
 * more input, so callers fall back to their default instead of hanging.
 */
async function readLine(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    out.write(promptText);
    await ensureBufferedStdin();
    const next = bufferedLines?.shift();
    out.write("\n");
    return (next ?? "").trim();
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: out });
    let answered = false;
    rl.question(promptText, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

/**
 * Single-choice selection. On a raw-capable TTY this is arrow-key driven with a
 * live highlighted cursor; otherwise it falls back to a numbered prompt read
 * from stdin (so piped input and non-raw terminals still work). Returns the
 * default when input is empty or unparseable.
 */
export async function select<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  defaultIndex?: number;
}): Promise<T> {
  const { options } = input;
  if (options.length === 0) throw new Error("select requires at least one option");
  const fallbackIndex = Math.min(Math.max(input.defaultIndex ?? 0, 0), options.length - 1);

  if (!canPromptInteractively()) {
    return selectNumbered(input.message, options, fallbackIndex);
  }
  return selectInteractive(input.message, options, fallbackIndex);
}

function optionAt<T>(options: ReadonlyArray<SelectOption<T>>, index: number): SelectOption<T> {
  const option = options[index];
  if (option === undefined) throw new Error(`option index out of range: ${index}`);
  return option;
}

async function selectNumbered<T>(
  message: string,
  options: ReadonlyArray<SelectOption<T>>,
  fallbackIndex: number
): Promise<T> {
  out.write(`${bold(message)}\n`);
  options.forEach((option, index) => {
    const marker = index === fallbackIndex ? cyan(`${index + 1}`) : `${index + 1}`;
    const hint = option.hint !== undefined ? dim(` — ${option.hint}`) : "";
    out.write(`  ${marker}) ${option.label}${hint}\n`);
  });
  const answer = await readLine(`Choose [1-${options.length}] (${fallbackIndex + 1}): `);
  if (answer.length === 0) return optionAt(options, fallbackIndex).value;
  const byNumber = Number.parseInt(answer, 10);
  if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= options.length) {
    return optionAt(options, byNumber - 1).value;
  }
  const byLabel = options.findIndex((option) => option.label.toLowerCase() === answer.toLowerCase());
  if (byLabel >= 0) return optionAt(options, byLabel).value;
  return optionAt(options, fallbackIndex).value;
}

function selectInteractive<T>(
  message: string,
  options: ReadonlyArray<SelectOption<T>>,
  fallbackIndex: number
): Promise<T> {
  return new Promise<T>((resolve) => {
    let cursor = fallbackIndex;
    let rendered = 0;
    const stdin = process.stdin;
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    out.write("\u001b[?25l");

    const render = (): void => {
      if (rendered > 0) {
        out.write(`\u001b[${rendered}A`);
        out.write("\u001b[0J");
      }
      const lines: string[] = [bold(message)];
      options.forEach((option, index) => {
        const active = index === cursor;
        const pointer = active ? cyan(glyph.pointer()) : " ";
        const label = active ? cyan(option.label) : option.label;
        const hint = option.hint !== undefined ? dim(` — ${option.hint}`) : "";
        lines.push(`${pointer} ${label}${hint}`);
      });
      lines.push(dim("  (arrows to move, enter to select)"));
      out.write(lines.join("\n") + "\n");
      rendered = lines.length;
    };

    const cleanup = (): void => {
      stdin.removeListener("keypress", onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write("\u001b[?25h");
    };

    const onKey = (_str: string, key: { name?: string; sequence?: string; ctrl?: boolean }): void => {
      if (key.sequence === "\u0003") {
        cleanup();
        out.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(optionAt(options, cursor).value);
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}

/** Yes/no confirmation. Returns `defaultValue` on empty input. */
export async function confirm(input: { message: string; defaultValue?: boolean }): Promise<boolean> {
  const def = input.defaultValue ?? false;
  const hint = def ? "[Y/n]" : "[y/N]";
  const answer = (await readLine(`${bold(input.message)} ${dim(hint)} `)).toLowerCase();
  if (answer.length === 0) return def;
  return answer === "y" || answer === "yes";
}

/** Free-text prompt. Returns `defaultValue` (or "") on empty input. */
export async function text(input: { message: string; defaultValue?: string }): Promise<string> {
  const suffix = input.defaultValue !== undefined && input.defaultValue.length > 0 ? dim(` (${input.defaultValue})`) : "";
  const answer = await readLine(`${bold(input.message)}${suffix} `);
  if (answer.length === 0) return input.defaultValue ?? "";
  return answer;
}

/** A success line for the end of a wizard. */
export function done(message: string): void {
  out.write(`${green(glyph.tick())} ${message}\n`);
}

/** A neutral note line. */
export function note(message: string): void {
  out.write(`${gray(glyph.arrow())} ${message}\n`);
}
