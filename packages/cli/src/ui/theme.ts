/**
 * Zero-dependency terminal theming. All color/format helpers no-op when color
 * is not supported (not a TTY, `NO_COLOR` set, or a dumb terminal), so output
 * stays clean when piped or captured. UI is written to stderr by convention so
 * the launched coding tool's stdout stays pristine.
 */

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
  pending: () => (supportsColor() ? "\u25cb" : "( )")
};

/** Frames for the in-place spinner (braille dots when color is on). */
export const SPINNER_FRAMES: readonly string[] = supportsColorFrames();

function supportsColorFrames(): readonly string[] {
  return ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
}

/** The product banner shown atop interactive surfaces. */
export function brandHeader(subtitle?: string): string {
  const title = bold(cyan("fusionkit"));
  const tag = dim("real model fusion behind your coding agent");
  const head = `${title}  ${tag}`;
  return subtitle === undefined ? head : `${head}\n${dim(subtitle)}`;
}
