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

/**
 * Compact display form of a trace id: strips the `trace_` prefix and
 * middle-truncates long ids so the distinguishing tail stays visible
 * (uuid-ish ids differ at the end, not the start).
 */
export function shortTraceId(traceId: string): string {
  const id = traceId.replace(/^trace_/, "");
  if (id.length <= 16) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

// Color helpers resolve to the semantic theme tokens defined in
// app/globals.css, so every visualization tracks the active light/dark theme.

export function statusColor(status: string | undefined): string {
  switch (status) {
    case "succeeded":
      return "var(--status-success)";
    case "failed":
      return "var(--status-danger)";
    case "running":
      return "var(--status-warning)";
    default:
      return "var(--status-neutral)";
  }
}

export function componentColor(component: string): string {
  switch (component) {
    case "gateway":
      return "var(--trace-gateway)";
    case "ensemble":
      return "var(--trace-ensemble)";
    case "agent":
      return "var(--trace-agent)";
    case "panel-model":
      return "var(--trace-panel-model)";
    case "judge":
      return "var(--trace-judge)";
    case "synthesis":
      return "var(--trace-synthesis)";
    case "cursor-bridge":
      return "var(--trace-cursor-bridge)";
    default:
      return "var(--trace-other)";
  }
}

export function stepColor(type: string): string {
  switch (type) {
    case "reasoning":
      return "var(--step-reasoning)";
    case "tool_call":
      return "var(--step-tool-call)";
    case "observation":
      return "var(--step-observation)";
    case "output":
      return "var(--step-output)";
    default:
      return "var(--step-other)";
  }
}
