import { pino } from "pino";
import type { Logger } from "pino";

/**
 * Structured plane logger. Level via the `level` argument or LOG_LEVEL,
 * defaulting to "silent" so the library never pollutes a host's stdout
 * unless logging is explicitly requested (operators set LOG_LEVEL=info, or
 * inject a configured logger via PlaneConfig.logger).
 */
export function createLogger(
  name = "warrant-plane",
  level: string = process.env.LOG_LEVEL ?? "silent"
): Logger {
  return pino({
    name,
    level,
    // The plane handles secrets and tokens; redact common carriers defensively.
    redact: {
      paths: [
        "token",
        "claimToken",
        "runnerToken",
        "enrollToken",
        "idpToken",
        "*.token",
        "req.headers.authorization"
      ],
      censor: "[redacted]"
    }
  });
}

/** Counters the plane increments for operational visibility. */
/**
 * Lightweight in-process counters exposed at /v1/metrics as JSON. This is a
 * deliberately minimal surface (counts, not histograms/labels): a deployment
 * that needs a Prometheus scrape format wraps these counters in its own
 * exporter rather than the plane taking on that dependency.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort());
  }
}

export type { Logger };
