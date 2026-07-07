/**
 * The prompt facade. On a raw-capable interactive TTY prompts render as Ink
 * components (arrow-key select, checkbox multi-select, live confirm/text);
 * otherwise they fall back to numbered/line prompts read from buffered stdin,
 * so piped answers (`printf "2\n" | fusionkit init`) and CI keep working
 * exactly as before. Every prompt settles into a persistent one-line answer.
 */
import { createInterface } from "node:readline";

import type { ReactElement } from "react";

import { canPromptInteractively, isInteractive, uiStream } from "./runtime.js";
import { bold, cyan, dim, glyph, gray, green } from "./theme.js";
import { mountInk, settleInk } from "./ink/presenter.js";
import {
  ConfirmPrompt,
  FuzzySelectPrompt,
  GhostTextPrompt,
  MultiSelectPrompt,
  SelectPrompt,
  TextPrompt
} from "./ink/prompts.js";
import type { FuzzyFeed, PromptOption } from "./ink/prompts.js";
import { Store } from "./ink/store.js";

export type SelectOption<T> = { value: T; label: string; hint?: string };

/** Returned by prompts with `allowBack: true` when the user presses Esc. */
export const BACK: unique symbol = Symbol("prompt.back");
export type Back = typeof BACK;

const out = uiStream();

// For non-interactive input (piped/redirected/empty stdin) we read all of stdin
// exactly once and serve answers line by line. This supports scripted input
// (`printf "2\n3\n" | fusionkit init`) and falls back to "" (the prompt
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

/** True when prompts should render as Ink components. */
function richPrompts(): boolean {
  return canPromptInteractively() && isInteractive();
}

/** Mount an Ink prompt, resolve on submit, and settle to a one-line answer. */
function runInkPrompt<T>(
  build: (handlers: {
    submit: (value: T, answer: string) => void;
    abort: () => void;
    back: () => void;
  }) => ReactElement
): Promise<T | Back> {
  return new Promise<T | Back>((resolve) => {
    let settled = false;
    const node = build({
      submit: (value, answer) => {
        if (settled) return;
        settled = true;
        settleInk(instance);
        out.write(`${green(glyph.tick())} ${answer}\n`);
        resolve(value);
      },
      abort: () => {
        if (settled) return;
        settled = true;
        settleInk(instance);
        out.write("\n");
        process.exit(130);
      },
      back: () => {
        if (settled) return;
        settled = true;
        settleInk(instance);
        out.write(`${gray(glyph.arrow())} ${dim("back")}\n`);
        resolve(BACK);
      }
    });
    const instance = mountInk(node);
  });
}

function answerLine(message: string, answer: string): string {
  return `${bold(message)} ${dim(`· ${answer}`)}`;
}

function optionAt<T>(options: ReadonlyArray<SelectOption<T>>, index: number): SelectOption<T> {
  const option = options[index];
  if (option === undefined) throw new Error(`option index out of range: ${index}`);
  return option;
}

/**
 * Single-choice selection. On a raw-capable TTY this is an Ink arrow-key
 * picker with a live highlighted cursor; otherwise it falls back to a numbered
 * prompt read from stdin (so piped input and non-raw terminals still work).
 * Returns the default when input is empty or unparseable.
 */
export async function select<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  defaultIndex?: number;
  allowBack: true;
}): Promise<T | Back>;
export async function select<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  defaultIndex?: number;
}): Promise<T>;
export async function select<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  defaultIndex?: number;
  allowBack?: boolean;
}): Promise<T | Back> {
  const { options } = input;
  if (options.length === 0) throw new Error("select requires at least one option");
  const fallbackIndex = Math.min(Math.max(input.defaultIndex ?? 0, 0), options.length - 1);

  if (!richPrompts()) {
    return selectNumbered(input.message, options, fallbackIndex);
  }
  return runInkPrompt<T>(({ submit, abort, back }) => (
    <SelectPrompt
      message={input.message}
      options={options}
      defaultIndex={fallbackIndex}
      onSubmit={(value, label) => submit(value, answerLine(input.message, label))}
      onAbort={abort}
      onBack={input.allowBack === true ? back : undefined}
    />
  ));
}

/**
 * Type-to-filter selection over a (possibly large or live-fetched) option
 * list: fuzzy subsequence filtering with highlighted matches, arrow keys to
 * move, enter to pick. `refresh` (when given) runs in the background while the
 * picker is open — the list starts on the cached `options` and live-updates
 * when fresh data lands (stale-while-revalidate). Falls back to the numbered
 * prompt off-TTY, awaiting `refresh` first only when no cached options exist.
 */
export async function fuzzySelect<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  refresh?: () => Promise<ReadonlyArray<SelectOption<T>>>;
  refreshNote?: string;
  placeholder?: string;
  allowBack: true;
}): Promise<T | Back>;
export async function fuzzySelect<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  refresh?: () => Promise<ReadonlyArray<SelectOption<T>>>;
  refreshNote?: string;
  placeholder?: string;
}): Promise<T>;
export async function fuzzySelect<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  refresh?: () => Promise<ReadonlyArray<SelectOption<T>>>;
  refreshNote?: string;
  placeholder?: string;
  allowBack?: boolean;
}): Promise<T | Back> {
  let options = input.options;

  if (!richPrompts()) {
    if (options.length === 0 && input.refresh !== undefined) {
      try {
        options = await input.refresh();
      } catch {
        // no fresh data either; fall through to the empty-list guard
      }
    }
    if (options.length === 0) throw new Error(`no options available: ${input.message}`);
    return selectNumbered(input.message, options, 0);
  }

  const feed = new Store<FuzzyFeed<T>>({
    options: options as ReadonlyArray<PromptOption<T>>,
    loading: input.refresh !== undefined,
    ...(input.refreshNote !== undefined ? { note: input.refreshNote } : {})
  });
  if (input.refresh !== undefined) {
    void input
      .refresh()
      .then((fresh) => {
        feed.set((state) => ({ ...state, options: fresh as ReadonlyArray<PromptOption<T>>, loading: false }));
      })
      .catch(() => {
        feed.set((state) => ({ ...state, loading: false }));
      });
  }
  return runInkPrompt<T>(({ submit, abort, back }) => (
    <FuzzySelectPrompt
      message={input.message}
      feed={feed}
      placeholder={input.placeholder}
      onSubmit={(value, label) => submit(value, answerLine(input.message, label))}
      onAbort={abort}
      onBack={input.allowBack === true ? back : undefined}
    />
  ));
}

/**
 * Free text with an inline ghost suggestion completed from `suggestions`
 * (Tab or → accepts). Falls back to the plain text prompt off-TTY.
 */
export async function autocompleteText(input: {
  message: string;
  suggestions: ReadonlyArray<string>;
  defaultValue?: string;
  placeholder?: string;
  allowBack?: boolean;
}): Promise<string | Back> {
  if (!richPrompts()) {
    return text({
      message: input.message,
      ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
      ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {})
    });
  }
  return runInkPrompt<string>(({ submit, abort, back }) => (
    <GhostTextPrompt
      message={input.message}
      suggestions={input.suggestions}
      defaultValue={input.defaultValue ?? ""}
      placeholder={input.placeholder}
      onSubmit={(value) => submit(value, answerLine(input.message, value.length > 0 ? value : "(empty)"))}
      onAbort={abort}
      onBack={input.allowBack === true ? back : undefined}
    />
  ));
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

/**
 * Multi-choice selection. On a raw-capable TTY this is an Ink checkbox list;
 * otherwise it reads comma-separated numbers from stdin (empty input keeps the
 * default selection).
 */
export async function multiselect<T>(input: {
  message: string;
  options: ReadonlyArray<SelectOption<T>>;
  defaultSelected?: readonly number[];
}): Promise<T[]> {
  const { options } = input;
  if (options.length === 0) return [];
  const defaults = new Set(
    (input.defaultSelected ?? []).filter((index) => index >= 0 && index < options.length)
  );

  if (!richPrompts()) {
    out.write(`${bold(input.message)}\n`);
    options.forEach((option, index) => {
      const marker = defaults.has(index) ? cyan(`${index + 1}`) : `${index + 1}`;
      const hint = option.hint !== undefined ? dim(` — ${option.hint}`) : "";
      out.write(`  ${marker}) ${option.label}${hint}\n`);
    });
    const fallback = [...defaults].sort((left, right) => left - right).map((index) => index + 1);
    const answer = await readLine(
      `Choose numbers, comma-separated (${fallback.length > 0 ? fallback.join(",") : "none"}): `
    );
    const picked = answer.length === 0 ? fallback : answer.split(",").map((part) => Number.parseInt(part.trim(), 10));
    const indices = [...new Set(picked)]
      .filter((num) => Number.isInteger(num) && num >= 1 && num <= options.length)
      .map((num) => num - 1)
      .sort((left, right) => left - right);
    return indices.map((index) => optionAt(options, index).value);
  }
  // No onBack handler is mounted, so BACK can never resolve here.
  return runInkPrompt<T[]>(({ submit, abort }) => (
    <MultiSelectPrompt
      message={input.message}
      options={options}
      defaultSelected={defaults}
      onSubmit={(values, labels) =>
        submit(values, answerLine(input.message, labels.length > 0 ? labels.join(", ") : "(none)"))
      }
      onAbort={abort}
    />
  )) as Promise<T[]>;
}

/** Yes/no confirmation. Returns `defaultValue` on empty input. */
export async function confirm(input: {
  message: string;
  defaultValue?: boolean;
  allowBack: true;
}): Promise<boolean | Back>;
export async function confirm(input: { message: string; defaultValue?: boolean }): Promise<boolean>;
export async function confirm(input: {
  message: string;
  defaultValue?: boolean;
  allowBack?: boolean;
}): Promise<boolean | Back> {
  const def = input.defaultValue ?? false;
  if (!richPrompts()) {
    const hint = def ? "[Y/n]" : "[y/N]";
    const answer = (await readLine(`${bold(input.message)} ${dim(hint)} `)).toLowerCase();
    if (answer.length === 0) return def;
    return answer === "y" || answer === "yes";
  }
  return runInkPrompt<boolean>(({ submit, abort, back }) => (
    <ConfirmPrompt
      message={input.message}
      defaultValue={def}
      onSubmit={(value) => submit(value, answerLine(input.message, value ? "yes" : "no"))}
      onAbort={abort}
      onBack={input.allowBack === true ? back : undefined}
    />
  ));
}

/** Free-text prompt. Returns `defaultValue` (or "") on empty input. */
export async function text(input: {
  message: string;
  defaultValue?: string;
  placeholder?: string;
  allowBack: true;
}): Promise<string | Back>;
export async function text(input: {
  message: string;
  defaultValue?: string;
  placeholder?: string;
}): Promise<string>;
export async function text(input: {
  message: string;
  defaultValue?: string;
  placeholder?: string;
  allowBack?: boolean;
}): Promise<string | Back> {
  if (!richPrompts()) {
    const suffix =
      input.defaultValue !== undefined && input.defaultValue.length > 0 ? dim(` (${input.defaultValue})`) : "";
    const answer = await readLine(`${bold(input.message)}${suffix} `);
    if (answer.length === 0) return input.defaultValue ?? "";
    return answer;
  }
  return runInkPrompt<string>(({ submit, abort, back }) => (
    <TextPrompt
      message={input.message}
      defaultValue={input.defaultValue ?? ""}
      {...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {})}
      onSubmit={(value) => submit(value, answerLine(input.message, value.length > 0 ? value : "(empty)"))}
      onAbort={abort}
      onBack={input.allowBack === true ? back : undefined}
    />
  ));
}

/** A success line for the end of a wizard. */
export function done(message: string): void {
  out.write(`${green(glyph.tick())} ${message}\n`);
}

/** A neutral note line. */
export function note(message: string): void {
  out.write(`${gray(glyph.arrow())} ${message}\n`);
}
