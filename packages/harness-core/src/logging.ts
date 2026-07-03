import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HarnessEvent } from "./events.js";

/**
 * Best-effort NDJSON event log, one file per session. Diagnostics must never
 * break the run: every write failure is swallowed. Large `raw` payloads are
 * summarized to a shape (byte length, field count) rather than written whole,
 * matching t3code's payload-privacy discipline.
 */
export type EventLogOptions = {
  dir: string;
  /** Rotate the file once it exceeds this many bytes (default 10 MiB). */
  maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "_session";
}

function summarizeRaw(raw: HarnessEvent["raw"]): unknown {
  if (raw === undefined) return undefined;
  const payload = raw.payload;
  let payloadSummary: unknown;
  if (payload !== undefined) {
    const json = JSON.stringify(payload);
    payloadSummary = {
      bytes: json.length,
      fields: typeof payload === "object" && payload !== null ? Object.keys(payload).length : 0
    };
  }
  return {
    source: raw.source,
    ...(raw.method !== undefined ? { method: raw.method } : {}),
    ...(payloadSummary !== undefined ? { payload: payloadSummary } : {})
  };
}

export class EventLog {
  readonly #dir: string;
  readonly #maxBytes: number;
  #ready = false;
  #broken = false;

  constructor(options: EventLogOptions) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  write(event: HarnessEvent): void {
    if (this.#broken) return;
    try {
      if (!this.#ready) {
        mkdirSync(this.#dir, { recursive: true });
        this.#ready = true;
      }
      const file = join(this.#dir, `${safeSegment(event.sessionId)}.ndjson`);
      this.#rotateIfNeeded(file);
      const line = JSON.stringify({ ...event, raw: summarizeRaw(event.raw) });
      appendFileSync(file, `${line}\n`);
    } catch {
      // A bad path must not retry hot for every event.
      this.#broken = true;
    }
  }

  #rotateIfNeeded(file: string): void {
    try {
      const size = statSync(file).size;
      if (size >= this.#maxBytes) renameSync(file, `${file}.1`);
    } catch {
      // No existing file (or stat failed): nothing to rotate.
    }
  }
}
