/** Small human-readable formatters shared across surfaces. */

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
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const capped = Math.min(seconds, 99 * 60 + 59);
  const mins = Math.floor(capped / 60);
  const secs = Math.floor(capped % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** A compact human-friendly "time ago" for a timestamp (epoch millis). */
export function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Truncate with a middle ellipsis so both ends stay recognizable — long model
 * ids like `openrouter:moonshotai/kimi-k2-thinking` keep their provider prefix
 * and model suffix. Plain-text only (measure/slice before styling).
 */
export function middleEllipsis(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  const ellipsis = "\u2026";
  const keep = max - ellipsis.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}${ellipsis}${tail > 0 ? text.slice(-tail) : ""}`;
}

/**
 * Greedy word-wrap to `width` columns. Words longer than the width are hard
 * split. Existing newlines are respected. Plain-text only.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= width) {
      out.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      let piece = word;
      while (piece.length > width) {
        if (line.length > 0) {
          out.push(line);
          line = "";
        }
        out.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      if (line.length === 0) line = piece;
      else if (line.length + 1 + piece.length <= width) line += ` ${piece}`;
      else {
        out.push(line);
        line = piece;
      }
    }
    out.push(line);
  }
  return out;
}

/** The usable content width for wrapped UI text on the current terminal. */
export function contentWidth(stream: NodeJS.WriteStream = process.stderr, max = 100): number {
  const columns = stream.columns;
  if (columns === undefined || columns <= 0) return Math.min(80, max);
  return Math.min(Math.max(columns - 4, 20), max);
}
