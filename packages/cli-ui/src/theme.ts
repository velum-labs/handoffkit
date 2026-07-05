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
  tick: () => (supportsColor() ? "\u2714" : "[ok]"),
  cross: () => (supportsColor() ? "\u2716" : "[x]"),
  bullet: () => (supportsColor() ? "\u2022" : "*"),
  arrow: () => (supportsColor() ? "\u203a" : ">"),
  pointer: () => (supportsColor() ? "\u276f" : ">"),
  warn: () => (supportsColor() ? "\u26a0" : "[!]"),
  pending: () => (supportsColor() ? "\u25cb" : "( )"),
  checkboxOn: () => (supportsColor() ? "\u25c9" : "[x]"),
  checkboxOff: () => (supportsColor() ? "\u25ef" : "[ ]")
};

/** Frames for the in-place spinner (braille dots when color is on). */
export const SPINNER_FRAMES: readonly string[] = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f"
];

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

/** Frame tones: neutral (dim) for informational boxes, error (red) for failures. */
export type BoxTone = "neutral" | "error";

/**
 * A hand-crafted rounded box around a titled block of lines. Uses box-drawing
 * characters when color (≈ a unicode TTY) is on, ASCII otherwise. Lines may
 * contain ANSI styling; widths are measured against the visible text so the
 * frame always aligns.
 */
export function box(title: string, lines: string[], options: { tone?: BoxTone } = {}): string {
  const rounded = supportsColor();
  const tl = rounded ? "\u256d" : "+";
  const tr = rounded ? "\u256e" : "+";
  const bl = rounded ? "\u2570" : "+";
  const br = rounded ? "\u256f" : "+";
  const h = rounded ? "\u2500" : "-";
  const v = rounded ? "\u2502" : "|";
  const frame: (text: string) => string = options.tone === "error" ? red : dim;

  const titleText = options.tone === "error" ? bold(red(title)) : bold(title);
  const contentWidth = Math.max(visibleWidth(titleText), ...lines.map(visibleWidth), 0);
  const inner = contentWidth + 2; // one space of padding each side

  // Build with un-nested styles: color the frame pieces, bold only the title,
  // so a bold reset (SGR 22) never prematurely closes a surrounding style.
  const titleRule = h.repeat(Math.max(0, inner - visibleWidth(titleText) - 3));
  const top = `${frame(`${tl}${h} `)}${titleText}${frame(` ${titleRule}${tr}`)}`;
  const body = lines.map((line) => {
    const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return `${frame(v)} ${line}${pad} ${frame(v)}`;
  });
  const bottom = frame(`${bl}${h.repeat(inner)}${br}`);
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
