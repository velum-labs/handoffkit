import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ingestEvent } from "./db";
import { isFusionTraceEvent } from "./types";

/**
 * Backfill the collector from the durable JSONL fallback that every emitter
 * writes when FUSION_TRACE_DIR is set. Safe to call repeatedly: ingestEvent is
 * idempotent by content hash.
 */
export function replayFromDir(dir: string): { files: number; ingested: number; skipped: number } {
  let files = 0;
  let ingested = 0;
  let skipped = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return { files: 0, ingested: 0, skipped: 0 };
  }
  for (const name of entries) {
    files += 1;
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isFusionTraceEvent(parsed)) {
        skipped += 1;
        continue;
      }
      if (ingestEvent(parsed)) ingested += 1;
    }
  }
  return { files, ingested, skipped };
}

export function defaultTraceDir(): string | undefined {
  return process.env.FUSION_TRACE_DIR ?? undefined;
}
