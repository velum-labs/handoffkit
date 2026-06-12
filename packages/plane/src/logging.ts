import { pino } from "pino";
import type { Logger } from "pino";

/**
 * Structured plane logger. Level via LOG_LEVEL; defaults to "silent" so the
 * library never pollutes a host's stdout unless logging is explicitly
 * requested (operators set LOG_LEVEL=info in deployment).
 */
export function createLogger(name = "warrant-plane"): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "silent",
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
