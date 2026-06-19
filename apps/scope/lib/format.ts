// Presentation helpers shared by client components (no node deps).

export function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Thousands-separated integer, e.g. 1234567 → "1,234,567". */
export function fmtNumber(value: number): string {
  return value.toLocaleString();
}

/** A compact relative timestamp ("just now", "2m ago", "3h ago"). */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  if (!ts) return "—";
  const deltaS = Math.max(0, Math.round((now - ts) / 1000));
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const minutes = Math.floor(deltaS / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function statusColor(status: string | undefined): string {
  switch (status) {
    case "succeeded":
      return "#3fb950";
    case "failed":
      return "#f85149";
    case "running":
      return "#d29922";
    case "skipped":
      return "#8b98a9";
    default:
      return "#8b98a9";
  }
}

export function componentColor(component: string): string {
  switch (component) {
    case "gateway":
      return "#6ea8fe";
    case "ensemble":
      return "#a371f7";
    case "agent":
      return "#56d4dd";
    case "panel-model":
      return "#3fb950";
    case "judge":
      return "#e3b341";
    case "synthesis":
      return "#db61a2";
    case "cursor-bridge":
      return "#f0883e";
    default:
      return "#8b98a9";
  }
}

export function stepColor(type: string): string {
  switch (type) {
    case "reasoning":
      return "#a371f7";
    case "tool_call":
      return "#6ea8fe";
    case "observation":
      return "#56d4dd";
    case "output":
      return "#3fb950";
    default:
      return "#8b98a9";
  }
}
