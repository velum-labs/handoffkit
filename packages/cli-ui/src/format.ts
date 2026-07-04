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
