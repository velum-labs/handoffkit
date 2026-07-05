/**
 * Terminal theming. All color/format helpers no-op when color is not supported
 * (not a TTY, `NO_COLOR` set, or a dumb terminal), so output stays clean when
 * piped or captured. UI is written to stderr by convention so the launched
 * coding tool's stdout stays pristine.
 *
 * `figlet` is used purely for the one-shot wordmark banner; everything else is
 * plain ANSI shared by the Ink presenter and the plain-text fallback.
 */
import figlet from "figlet";

/** True when ANSI styling should be emitted to the given stream. */
export function supportsColor(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

type Style = (text: string) => string;

function wrap(open: number, close: number): Style {
  return (text: string) => (supportsColor() ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** Status glyphs, with ASCII fallbacks when color (≈ unicode-friendly TTY) is off. */
export const glyph = {
  tick: () => (supportsColor() ? "✔" : "[ok]"),
  cross: () => (supportsColor() ? "✖" : "[x]"),
  bullet: () => (supportsColor() ? "•" : "*"),
  arrow: () => (supportsColor() ? "›" : ">"),
  pointer: () => (supportsColor() ? "❯" : ">"),
  warn: () => (supportsColor() ? "⚠" : "[!]"),
  pending: () => (supportsColor() ? "○" : "( )"),
  checkboxOn: () => (supportsColor() ? "◉" : "[x]"),
  checkboxOff: () => (supportsColor() ? "◯" : "[ ]")
};

/** Frames for the in-place spinner (braille dots when color is on). */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The product tagline, shown beneath the banner/header. */
const BRAND_TAGLINE = "real model fusion behind your coding agent";

/** The compact one-line product header (used for sub-surfaces and fallbacks). */
export function brandHeader(subtitle?: string): string {
  const title = bold(cyan("fusionkit"));
  const tag = dim(BRAND_TAGLINE);
  const head = `${title}  ${tag}`;
  return subtitle === undefined ? head : `${head}\n${dim(subtitle)}`;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Remove ANSI styling so we can measure on-screen width. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Visible (printed) width of a string, ignoring ANSI escapes. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Track open SGR codes across a sequence boundary (theme styles only). */
function applySgr(active: string[], sequence: string): void {
  const body = sequence.slice(2, -1);
  const drop = (codes: readonly string[]): void => {
    for (let index = active.length - 1; index >= 0; index--) {
      const code = active[index] ?? "";
      if (codes.includes(code) || (codes.includes("38") && code.startsWith("38;"))) active.splice(index, 1);
    }
  };
  if (body === "" || body === "0") active.length = 0;
  else if (body === "22") drop(["1", "2"]);
  else if (body === "23") drop(["3"]);
  else if (body === "24") drop(["4"]);
  else if (body === "39") drop(["31", "32", "33", "34", "35", "36", "90", "38"]);
  else active.push(body);
}

/**
 * Greedy word-wrap that is safe for ANSI-styled text: visible width is
 * measured without escapes, and styles that are open at a line break are
 * closed at the end of the line and re-opened on the next, so every returned
 * line renders standalone.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (visibleWidth(paragraph) <= width) {
      lines.push(paragraph);
      continue;
    }
    // Codes open at the current position; re-opened at each new line start.
    const active: string[] = [];
    let line = "";
    let lineWidth = 0;

    const endLine = (): void => {
      lines.push(active.length > 0 ? `${line}\u001b[0m` : line);
      line = active.map((code) => `\u001b[${code}m`).join("");
      lineWidth = 0;
    };

    for (const word of paragraph.split(" ")) {
      const wordWidth = visibleWidth(word);
      if (lineWidth > 0) {
        if (lineWidth + 1 + wordWidth <= width) {
          line += " ";
          lineWidth += 1;
        } else {
          endLine();
        }
      }
      if (wordWidth <= width) {
        for (const escape of word.match(ANSI_PATTERN) ?? []) applySgr(active, escape);
        line += word;
        lineWidth += wordWidth;
        continue;
      }
      // A single word wider than the line (URL, long id): hard split.
      let index = 0;
      while (index < word.length) {
        const escape = /^\u001b\[[0-9;]*m/.exec(word.slice(index));
        if (escape !== null) {
          applySgr(active, escape[0]);
          line += escape[0];
          index += escape[0].length;
          continue;
        }
        if (lineWidth >= width) endLine();
        line += word[index] ?? "";
        lineWidth += 1;
        index += 1;
      }
    }
    if (stripAnsi(line).length > 0) {
      lines.push(active.length > 0 ? `${line}\u001b[0m` : line);
    }
  }
  return lines;
}

/** Frame tones: neutral (dim) for informational boxes, error (red) for failures. */
export type BoxTone = "neutral" | "error";

/** The widest a box may draw on the current terminal (frame included). */
function maxBoxWidth(stream: NodeJS.WriteStream = process.stderr): number {
  const columns = stream.columns;
  if (columns === undefined || columns <= 0) return 84;
  return Math.min(Math.max(columns, 24), 100);
}

/** One set of box-drawing characters (rounded unicode or plain ASCII). */
type BoxChars = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
};

const ROUNDED_BOX: BoxChars = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│"
};

const ASCII_BOX: BoxChars = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|"
};

/**
 * A titled, framed block rendered as plain strings. Rounded box-drawing
 * characters when color (≈ a unicode TTY) is on, ASCII otherwise. Lines may
 * contain ANSI styling; widths are measured against the visible text so the
 * frame always aligns. The box never draws wider than the terminal — content
 * lines that would overflow are word-wrapped (ANSI-safely) instead.
 *
 * Deliberately NOT Ink's `<Box borderStyle>`: Ink borders only exist inside a
 * mounted live app, while these boxes are *transcript* output — written once
 * to the stream and left in scrollback. They must render identically from the
 * plain presenter (non-TTY, `--quiet`, CI), from the top-level error handler
 * after any Ink app has unmounted, and inside string-snapshot tests, none of
 * which can mount a React tree.
 */
export function box(title: string, lines: string[], options: { tone?: BoxTone } = {}): string {
  const chars = supportsColor() ? ROUNDED_BOX : ASCII_BOX;
  const frame: (text: string) => string = options.tone === "error" ? red : dim;

  const titleText = options.tone === "error" ? bold(red(title)) : bold(title);
  // "│ " + content + " │" -> the frame consumes 4 columns.
  const maxContent = maxBoxWidth() - 4;
  const wrapped = lines.flatMap((line) => {
    if (visibleWidth(line) <= maxContent) return [line];
    // Indent wrapped continuations so they read as part of the first line.
    return wrapAnsi(line, maxContent - 2).map((part, index) => (index === 0 ? part : `  ${part}`));
  });
  const contentWidth = Math.min(
    Math.max(visibleWidth(titleText), ...wrapped.map(visibleWidth), 0),
    maxContent
  );
  const inner = contentWidth + 2; // one space of padding each side

  // Build with un-nested styles: color the frame pieces, bold only the title,
  // so a bold reset (SGR 22) never prematurely closes a surrounding style.
  const titleRule = chars.horizontal.repeat(Math.max(0, inner - visibleWidth(titleText) - 3));
  const top = `${frame(`${chars.topLeft}${chars.horizontal} `)}${titleText}${frame(` ${titleRule}${chars.topRight}`)}`;
  const body = wrapped.map((line) => {
    const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${frame(chars.vertical)} ${line}${pad} ${frame(chars.vertical)}`;
  });
  const bottom = frame(`${chars.bottomLeft}${chars.horizontal.repeat(inner)}${chars.bottomRight}`);
  return [top, ...body, bottom].join("\n");
}

/** True when the terminal advertises 24-bit color (needed for the gradient). */
function supportsTrueColor(): boolean {
  if (!supportsColor()) return false;
  const colorterm = process.env.COLORTERM ?? "";
  return colorterm.includes("truecolor") || colorterm.includes("24bit");
}

type RGB = readonly [number, number, number];
/** Gradient endpoints: cyan-400 -> fuchsia-500, for the "magical" wordmark. */
const GRADIENT_FROM: RGB = [34, 211, 238];
const GRADIENT_TO: RGB = [217, 70, 239];

function mix(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

/**
 * Apply a left-to-right truecolor gradient across each line of `text`. Returns
 * the text unchanged when 24-bit color is unavailable (callers pick a fallback
 * color). Spaces are left uncolored so the escape sequences stay minimal.
 */
export function gradient(text: string): string {
  if (!supportsTrueColor()) return text;
  const lines = text.split("\n");
  const width = Math.max(1, ...lines.map((line) => line.length));
  return lines
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i] ?? "";
        if (ch === " ") {
          out += ch;
          continue;
        }
        const t = width <= 1 ? 0 : i / (width - 1);
        const r = mix(GRADIENT_FROM[0], GRADIENT_TO[0], t);
        const g = mix(GRADIENT_FROM[1], GRADIENT_TO[1], t);
        const b = mix(GRADIENT_FROM[2], GRADIENT_TO[2], t);
        out += `\u001b[38;2;${r};${g};${b}m${ch}`;
      }
      return out + "\u001b[39m";
    })
    .join("\n");
}

/**
 * The full-dress figlet wordmark + gradient + tagline, shown once per command
 * as an entrance "moment". Degrades gracefully to the one-line {@link
 * brandHeader} when color is off, the terminal is too narrow, or figlet is
 * somehow unavailable — preserving clean output when piped or captured.
 */
export function brandBanner(subtitle?: string): string {
  const fallback = brandHeader(subtitle);
  if (!supportsColor()) return fallback;

  let art: string;
  try {
    art = figlet.textSync("fusionkit", { font: "ANSI Shadow" });
  } catch {
    return fallback;
  }
  // Drop trailing blank lines figlet pads with, keep the shape otherwise.
  const lines = art.replace(/[\s\n]+$/u, "").split("\n");
  const widest = Math.max(0, ...lines.map((line) => line.length));
  const columns = process.stderr.columns;
  if (columns !== undefined && widest > columns) return fallback;

  const trimmed = lines.join("\n");
  const wordmark = supportsTrueColor() ? gradient(trimmed) : bold(cyan(trimmed));
  const tag = dim(BRAND_TAGLINE);
  const sub = subtitle !== undefined ? `\n${dim(subtitle)}` : "";
  return `${wordmark}\n${tag}${sub}`;
}
